import { MongoClient } from "mongodb";
import { getErrorMessage, withTimeout } from "@rodrigo-barraza/utilities-library";
import type { InfrastructureEntry, InfraStatus } from "../types.ts";
import { INFRASTRUCTURE, HEALTH_CHECK_TIMEOUT_MS, MONGO_URI } from "../config.ts";
import logger from "../utils/logger.ts";
import { DeviceResolver } from "../utils/DeviceResolver.ts";
import MinioService from "./MinioService.ts";

type InfraProbe = (infra: InfrastructureEntry) => Promise<Record<string, unknown> | null>;
type ProbeFields = Pick<InfraStatus, "healthy" | "responseTimeMs" | "metadata" | "error" | "checkedAt">;

// Whole-probe deadline. The Mongo probe issues up to three commands and
// the driver's timeouts cover connection setup, not a stalled server — so
// every probe is bounded here, keeping the shared round from hanging.
const PROBE_TIMEOUT_MS = HEALTH_CHECK_TIMEOUT_MS * 2;

const statusCache = new Map<string, InfraStatus>();
let roundInflight: Promise<InfraStatus[]> | null = null;

// Persistent health-check client — reconnecting via a fresh MongoClient on
// every 60s sweep costs a full TCP + auth handshake and spams the server's
// connection log. The driver's topology monitoring handles reconnects; on
// command failure we discard the client so the next sweep starts clean.
let healthCheckMongoClient: MongoClient | null = null;

function toStatus(id: string, infra: InfrastructureEntry, probe: ProbeFields): InfraStatus {
  return {
    id,
    name: infra.name,
    type: infra.type,
    projectType: infra.projectType || null,
    url: infra.url,
    port: infra.port,
    environment: infra.environment,
    visibility: infra.visibility,
    domain: infra.domain || null,
    device: DeviceResolver.deriveHost(infra.url, infra.device),
    dependsOn: infra.dependsOn || [],
    deployTier: infra.deployTier ?? 0,
    isInfrastructure: true,
    ...probe,
  };
}

async function getHealthCheckMongoClient(): Promise<MongoClient> {
  if (!healthCheckMongoClient) {
    const client = new MongoClient(String(MONGO_URI), {
      serverSelectionTimeoutMS: HEALTH_CHECK_TIMEOUT_MS,
      connectTimeoutMS: HEALTH_CHECK_TIMEOUT_MS,
      maxPoolSize: 2,
    });
    await client.connect();
    healthCheckMongoClient = client;
  }
  return healthCheckMongoClient;
}

async function checkMongo(): Promise<Record<string, unknown>> {
  if (!MONGO_URI) throw new Error("No MONGO_URI configured");

  try {
    const admin = (await getHealthCheckMongoClient()).db("admin");
    await admin.command({ ping: 1 });

    const metadata: Record<string, unknown> = { version: null, uptime: null, connections: null, databases: null };

    try {
      const serverStatus = await admin.command({ serverStatus: 1 });
      metadata.version = serverStatus.version;
      metadata.uptime = serverStatus.uptime;
      metadata.connections = serverStatus.connections?.current ?? null;
    } catch {
      // User may lack clusterMonitor / root role — that's fine
    }

    try {
      const dbList = await admin.command({ listDatabases: 1, nameOnly: true });
      metadata.databases = dbList.databases?.length ?? null;
    } catch {
      // Requires listDatabases privilege
    }

    return metadata;
  } catch (error: unknown) {
    // Discard the cached client so the next sweep reconnects from scratch
    await InfrastructureRegistryService.closeHealthCheckClient();
    throw error;
  }
}

async function checkMinio(): Promise<Record<string, unknown>> {
  // Reuses the object-store route's client instead of building one per sweep
  const buckets = await (await MinioService._getClient()).listBuckets();
  return {
    buckets: buckets.length,
    bucketNames: buckets.map((bucket) => bucket.name),
  };
}

async function checkHttp(infra: InfrastructureEntry): Promise<Record<string, unknown>> {
  if (!infra.url) throw new Error("No URL configured");

  const url = `${infra.url.replace(/\/+$/, "")}${infra.healthPath || "/"}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return { status: "ok" };
  }
}

// Registry infrastructure `type` → health probe.
const PROBES: Record<string, InfraProbe> = {
  database: checkMongo,
  "object-store": checkMinio,
  inference: checkHttp,
};

export default class InfrastructureRegistryService {
  public static list(): InfraStatus[] {
    return Object.entries(INFRASTRUCTURE).map(
      ([id, infra]) =>
        statusCache.get(id) ??
        toStatus(id, infra, {
          healthy: false,
          responseTimeMs: null,
          metadata: null,
          error: "Not yet checked",
          checkedAt: null,
        }),
    );
  }

  /** Probe every infrastructure entry; concurrent callers share one round. */
  public static checkAll(): Promise<InfraStatus[]> {
    roundInflight ??= InfrastructureRegistryService._runRound().finally(() => {
      roundInflight = null;
    });
    return roundInflight;
  }

  private static async _runRound(): Promise<InfraStatus[]> {
    const entries = Object.entries(INFRASTRUCTURE);
    const results = await Promise.all(
      entries.map(([id, infra]) => InfrastructureRegistryService._checkInfra(id, infra)),
    );

    const liveIds = new Set(entries.map(([id]) => id));
    for (const id of statusCache.keys()) {
      if (!liveIds.has(id)) statusCache.delete(id);
    }
    for (const status of results) {
      statusCache.set(status.id, status);
    }
    return results;
  }

  public static async _checkInfra(id: string, infra: InfrastructureEntry): Promise<InfraStatus> {
    const probe = PROBES[infra.type];

    // No probe for this type: say so. Reporting it healthy would hide a
    // dead store; checkedAt stays null so the UI and the watchdog treat it
    // as unknown (never paged), not as down.
    if (!probe) {
      return toStatus(id, infra, {
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: `Unchecked — no health probe for infrastructure type "${infra.type}"`,
        checkedAt: null,
      });
    }

    const start = Date.now();
    try {
      const metadata = await withTimeout(probe(infra), PROBE_TIMEOUT_MS, "Timeout");
      return toStatus(id, infra, {
        healthy: true,
        responseTimeMs: Date.now() - start,
        metadata,
        error: null,
        checkedAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      const isTimeout =
        error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      const message = isTimeout ? "Timeout" : getErrorMessage(error);
      logger.warn(`[InfraRegistry] ${infra.name} unreachable: ${message}`);
      return toStatus(id, infra, {
        healthy: false,
        responseTimeMs: Date.now() - start,
        metadata: null,
        error: message,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  /** Close the dedicated health-check connection (shutdown, or after a failed probe). */
  public static async closeHealthCheckClient(): Promise<void> {
    const client = healthCheckMongoClient;
    healthCheckMongoClient = null;
    await client?.close().catch(() => {});
  }
}
