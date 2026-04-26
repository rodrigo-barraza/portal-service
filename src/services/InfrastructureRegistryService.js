// ============================================================
// Portal API — Infrastructure Registry Service
// ============================================================
// Protocol-level health checks for non-HTTP backing services
// (MongoDB, MinIO). Cached in-memory and polled periodically.
// ============================================================

import { MongoClient } from "mongodb";
import { Client as MinioClient } from "minio";
import {
  INFRASTRUCTURE,
  DEVICES,
  HEALTH_CHECK_TIMEOUT_MS,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MONGO_URI,
} from "../config.js";
import logger from "../utils/logger.js";

/**
 * Infrastructure status snapshot.
 * @typedef {object} InfraStatus
 * @property {string} id
 * @property {string} name
 * @property {string} type       - "database" | "object-store"
 * @property {string} url
 * @property {number|null} port
 * @property {"Production"|"Development"} stage
 * @property {string} host       - Resolved device name
 * @property {boolean} healthy
 * @property {number|null} responseTimeMs
 * @property {object|null} metadata
 * @property {string|null} error
 * @property {string} checkedAt  - ISO timestamp
 * @property {boolean} isInfrastructure
 */

/** @type {Map<string, InfraStatus>} */
const statusCache = new Map();

export default class InfrastructureRegistryService {
  /**
   * Get all infrastructure services with their current status.
   * @returns {InfraStatus[]}
   */
  static list() {
    return Object.entries(INFRASTRUCTURE).map(([id, infra]) => {
      const cached = statusCache.get(id);
      return cached || {
        id,
        name: infra.name,
        type: infra.type,
        url: infra.url,
        port: infra.port,
        stage: infra.stage,
        visibility: infra.visibility,
        host: DEVICES[infra.device]?.name || infra.device || "Unknown",
        dependsOn: infra.dependsOn || [],
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: "Not yet checked",
        checkedAt: null,
        isInfrastructure: true,
      };
    });
  }

  /**
   * Poll all infrastructure services and update cache.
   * @returns {Promise<InfraStatus[]>}
   */
  static async checkAll() {
    const results = await Promise.all(
      Object.entries(INFRASTRUCTURE).map(([id, infra]) =>
        InfrastructureRegistryService._checkInfra(id, infra),
      ),
    );

    for (const status of results) {
      statusCache.set(status.id, status);
    }

    return results;
  }

  /**
   * @param {string} id
   * @param {object} infra
   * @returns {Promise<InfraStatus>}
   */
  static async _checkInfra(id, infra) {
    const base = {
      id,
      name: infra.name,
      type: infra.type,
      url: infra.url,
      port: infra.port,
      stage: infra.stage,
      visibility: infra.visibility,
      host: DEVICES[infra.device]?.name || infra.device || "Unknown",
      dependsOn: infra.dependsOn || [],
      isInfrastructure: true,
    };

    const start = Date.now();

    try {
      let metadata = null;

      if (infra.type === "database") {
        metadata = await InfrastructureRegistryService._checkMongo();
      } else if (infra.type === "object-store") {
        metadata = await InfrastructureRegistryService._checkMinio();
      }

      return {
        ...base,
        healthy: true,
        responseTimeMs: Date.now() - start,
        metadata,
        error: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      logger.warn(`[InfraRegistry] ${infra.name} unreachable: ${err.message}`);
      return {
        ...base,
        healthy: false,
        responseTimeMs: Date.now() - start,
        metadata: null,
        error: err.name === "AbortError" ? "Timeout" : err.message,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * MongoDB health check — connects, runs admin ping, disconnects.
   * Uses a short-lived client to avoid leaking connections.
   * Gracefully handles limited privileges — ping is sufficient for liveness.
   * @returns {Promise<object>}
   */
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

  /**
   * MinIO health check — connects, lists buckets, disconnects.
   * @returns {Promise<object>}
   */
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
    const buckets = await Promise.race([
      client.listBuckets(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Timeout")),
          HEALTH_CHECK_TIMEOUT_MS,
        ),
      ),
    ]);

    return {
      buckets: buckets.length,
      bucketNames: buckets.map((b) => b.name),
    };
  }
}
