// ─── Infrastructure Registry Service ────────────────────────

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
 * Build a reverse lookup: hostname/IP → device name.
 */
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

/**
 * Derive the display device name from a URL.
 * Reverse-looks up the URL hostname against the DEVICES table.
 */
function deriveHost(url, infra) {
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

/**
 * Infrastructure status snapshot.
 * @typedef {object} InfraStatus
 * @property {string} id
 * @property {string} name
 * @property {string} type       - "database" | "object-store"
 * @property {string} url
 * @property {number|null} port
 * @property {"Production"|"Development"} environment
 * @property {string} device    - Resolved device name
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
      let metadata = null;

      if (infra.type === "database") {
        metadata = await InfrastructureRegistryService._checkMongo();
      } else if (infra.type === "object-store") {
        metadata = await InfrastructureRegistryService._checkMinio();
      } else if (infra.type === "inference") {
        metadata = await InfrastructureRegistryService._checkHttp(infra);
      }

      return {
        ...base,
        healthy: true,
        responseTimeMs: Date.now() - start,
        metadata,
        error: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.warn(`[InfraRegistry] ${infra.name} unreachable: ${error.message}`);
      return {
        ...base,
        healthy: false,
        responseTimeMs: Date.now() - start,
        metadata: null,
        error: error.name === "AbortError" ? "Timeout" : error.message,
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

  /**
   * Generic HTTP health check — hits url + healthPath.
   * Used for inference servers (LM Studio) and any future HTTP-based infra.
   * @param {object} infra
   * @returns {Promise<object>}
   */
  static async _checkHttp(infra) {
    const baseUrl = infra.url;
    const healthPath = infra.healthPath || "/";
    if (!baseUrl) throw new Error("No URL configured");

    const url = `${baseUrl.replace(/\/+$/, "")}${healthPath}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      try {
        return await res.json();
      } catch {
        return { status: "ok" };
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
