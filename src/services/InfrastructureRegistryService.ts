import { MongoClient } from "mongodb";
import type { BucketItemFromList } from "minio";
import { createMinioClient } from "@rodrigo-barraza/utilities-library/service/minio";
import type { InfrastructureEntry, InfraStatus } from "../types.ts";
import {
  INFRASTRUCTURE,
  HEALTH_CHECK_TIMEOUT_MS,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MONGO_URI,
} from "../config.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { DeviceResolver } from "../utils/DeviceResolver.ts";

const statusCache = new Map<string, InfraStatus>();

export default class InfrastructureRegistryService {
  public static list(): InfraStatus[] {
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
        device: DeviceResolver.deriveHost(infra.url, infra.device),
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

  public static async checkAll(): Promise<InfraStatus[]> {
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

  public static async _checkInfra(id: string, infra: InfrastructureEntry): Promise<InfraStatus> {
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
      device: DeviceResolver.deriveHost(infra.url, infra.device),
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

  // Persistent health-check client — reconnecting via a fresh MongoClient on
  // every 60s sweep costs a full TCP + auth handshake and spams the server's
  // connection log. The driver's topology monitoring handles reconnects; on
  // command failure we discard the client so the next sweep starts clean.
  static _healthCheckClient: MongoClient | null = null;

  static async _getHealthCheckMongoClient(): Promise<MongoClient> {
    if (!InfrastructureRegistryService._healthCheckClient) {
      const client = new MongoClient(String(MONGO_URI), {
        serverSelectionTimeoutMS: HEALTH_CHECK_TIMEOUT_MS,
        connectTimeoutMS: HEALTH_CHECK_TIMEOUT_MS,
        maxPoolSize: 2,
      });
      await client.connect();
      InfrastructureRegistryService._healthCheckClient = client;
    }
    return InfrastructureRegistryService._healthCheckClient;
  }

  public static async _checkMongo() {
    if (!MONGO_URI) throw new Error("No MONGO_URI configured");

    try {
      const client = await InfrastructureRegistryService._getHealthCheckMongoClient();
      const admin = client.db("admin");

      await admin.command({ ping: 1 });

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
    } catch (error: unknown) {
      // Discard the cached client so the next sweep reconnects from scratch
      const staleClient = InfrastructureRegistryService._healthCheckClient;
      InfrastructureRegistryService._healthCheckClient = null;
      if (staleClient) await staleClient.close().catch(() => {});
      throw error;
    }
  }

  public static async _checkMinio() {
    if (!MINIO_ENDPOINT) throw new Error("No MINIO_ENDPOINT configured");

    const client = await createMinioClient({
      endpoint: MINIO_ENDPOINT,
      accessKey: MINIO_ACCESS_KEY || "",
      secretKey: MINIO_SECRET_KEY || "",
    });

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

  public static async _checkHttp(infra: InfrastructureEntry) {
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
