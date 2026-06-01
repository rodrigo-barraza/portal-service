// ─── Infrastructure Registry Service ────────────────────────

import { MongoClient } from "mongodb";
import { Client as MinioClient, type BucketItemFromList } from "minio";
import type { InfrastructureEntry, InfraStatus } from "../types.ts";
import {
  INFRASTRUCTURE,
  DEVICES,
  HEALTH_CHECK_TIMEOUT_MS,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MONGO_URI,
} from "../config.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

function buildHostnameToDeviceMap() {
  const map = new Map();
  for (const [_key, device] of Object.entries(DEVICES)) {
    if (device.hostname) map.set(device.hostname, device.name);
  }
  // Localhost aliases → local device (imports os at top if needed)
  map.set("localhost", DEVICES.workstation?.name || "Workstation");
  map.set("127.0.0.1", DEVICES.workstation?.name || "Workstation");
  return map;
}

const HOSTNAME_TO_DEVICE = buildHostnameToDeviceMap();

function deriveHost(url: string | null | undefined, infra: InfrastructureEntry) {
  if (!url) return DEVICES[infra.device]?.name || infra.device || "Unknown";
  try {
    const parsed = new URL(url);
    return HOSTNAME_TO_DEVICE.get(parsed.hostname)
      || DEVICES[infra.device]?.name
      || infra.device
      || "Unknown";
  } catch {
    return DEVICES[infra.device]?.name || infra.device || "Unknown";
  }
}



const statusCache = new Map();

export default class InfrastructureRegistryService {
    static list(): InfraStatus[] {
    return Object.entries(INFRASTRUCTURE).map(([id, infra]) => {
      const cached = statusCache.get(id);
      return cached || {
        id,
        name: infra.name,
        type: infra.type,
        projectType: infra.projectType || null,
        url: infra.url,
        port: infra.port,
        environment: infra.environment,
        visibility: infra.visibility,
        domain: infra.domain || null,
        device: deriveHost(infra.url, infra),
        dependsOn: infra.dependsOn || [],
        deployTier: infra.deployTier ?? 0,
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: "Not yet checked",
        checkedAt: null,
        isInfrastructure: true,
      };
    });
  }

    static async checkAll(): Promise<InfraStatus[]> {
    const results = await Promise.all(
      Object.entries(INFRASTRUCTURE).map(([id, infra]) =>
        InfrastructureRegistryService._checkInfra(id, infra as InfrastructureEntry),
      ),
    );

    for (const status of results) {
      statusCache.set(status.id, status);
    }

    return results;
  }

  static async _checkInfra(id: string, infra: InfrastructureEntry): Promise<InfraStatus> {
    const base = {
      id,
      name: infra.name,
      type: infra.type,
      projectType: infra.projectType || null,
      url: infra.url,
      port: infra.port,
      environment: infra.environment,
      visibility: infra.visibility,
      domain: infra.domain || null,
      device: deriveHost(infra.url, infra),
      dependsOn: infra.dependsOn || [],
      deployTier: infra.deployTier ?? 0,
      isInfrastructure: true,
    };

    const start = Date.now();

    try {
      let metadata: Record<string, unknown> | null = null;

      if (infra.type === "database") {
        metadata = await InfrastructureRegistryService._checkMongo();
      } else if (infra.type === "object-store") {
        metadata = await InfrastructureRegistryService._checkMinio();
      } else if (infra.type === "inference") {
        metadata = await InfrastructureRegistryService._checkHttp(infra) as Record<string, unknown>;
      }

      return {
        ...base,
        healthy: true,
        responseTimeMs: Date.now() - start,
        metadata,
        error: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error: unknown) {
      const errorObject = error instanceof Error ? error : new Error(String(error));
      logger.warn(`[InfraRegistry] ${infra.name} unreachable: ${getErrorMessage(error)}`);
      return {
        ...base,
        healthy: false,
        responseTimeMs: Date.now() - start,
        metadata: null,
        error: errorObject.name === "AbortError" ? "Timeout" : errorObject.message,
        checkedAt: new Date().toISOString(),
      } as InfraStatus;
    }
  }

    static async _checkMongo() {
    if (!MONGO_URI) throw new Error("No MONGO_URI configured");

    const client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: HEALTH_CHECK_TIMEOUT_MS,
      connectTimeoutMS: HEALTH_CHECK_TIMEOUT_MS,
    });

    try {
      await client.connect();
      const admin = client.db("admin");

      // Ping for liveness (always succeeds if connected)
      await admin.command({ ping: 1 });

      // Gather server metadata — may fail if user lacks clusterMonitor role
      const metadata = { version: null, uptime: null, connections: null, databases: null };

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
    } finally {
      await client.close();
    }
  }

    static async _checkMinio() {
    if (!MINIO_ENDPOINT) throw new Error("No MINIO_ENDPOINT configured");

    const url = new URL(MINIO_ENDPOINT);
    const client = new MinioClient({
      endPoint: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
      useSSL: url.protocol === "https:",
      accessKey: MINIO_ACCESS_KEY || "",
      secretKey: MINIO_SECRET_KEY || "",
    });

    // listBuckets is the lightest authenticated S3 call
    const buckets = await Promise.race<BucketItemFromList[]>([
      client.listBuckets(),
      new Promise<BucketItemFromList[]>((_, reject) =>
        setTimeout(
          () => reject(new Error("Timeout")),
          HEALTH_CHECK_TIMEOUT_MS,
        ),
      ),
    ]);

    return {
      buckets: buckets.length,
      bucketNames: buckets.map((bucket) => bucket.name),
    };
  }

    static async _checkHttp(infra: InfrastructureEntry) {
    const baseUrl = infra.url;
    const healthPath = infra.healthPath || "/";
    if (!baseUrl) throw new Error("No URL configured");

    const url = `${baseUrl.replace(/\/+$/, "")}${healthPath}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      try {
        return await response.json();
      } catch {
        return { status: "ok" };
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
