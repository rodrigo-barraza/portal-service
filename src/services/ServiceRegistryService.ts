import type { ProjectEntry } from "../types.ts";
// ─── Service Registry Service ───────────────────────────────

import os from "os";
import { PROJECTS, DEVICES, HEALTH_CHECK_TIMEOUT_MS } from "../config.ts";
import logger from "../utils/logger.ts";
import { ERROR_CODE_LABELS } from "../types.ts";

/**
 * Detect the device key that this API instance is running on.
 * Matches the machine's real network-interface IPs against DEVICES hostnames.
 *
 * NOTE: We intentionally exclude "localhost" / "127.0.0.1" from the set
 * because every host (including Docker containers) owns those addresses,
 * which would cause false positives — e.g. a container on Synology
 * incorrectly matching as the Workstation device.
 */
function detectLocalDevice() {
  const interfaces = os.networkInterfaces();
  const localIPs = new Set();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (!addr.internal) localIPs.add(addr.address);
    }
  }

  for (const [key, device] of Object.entries(DEVICES)) {
    if (device.hostname && localIPs.has(device.hostname)) return key;
  }
  return null;
}

const LOCAL_DEVICE_KEY = detectLocalDevice();

/**
 * Build a reverse lookup: hostname/IP → device name.
 * Maps each device's configured hostname plus localhost aliases
 * for the local device, so we always resolve a friendly name.
 */
function buildHostnameToDeviceMap() {
  const map = new Map();

  for (const [_key, device] of Object.entries(DEVICES)) {
    if (device.hostname) map.set(device.hostname, device.name);
  }

  // Map localhost aliases to whichever device we're running on
  if (LOCAL_DEVICE_KEY) {
    const localName = DEVICES[LOCAL_DEVICE_KEY].name;
    map.set("localhost", localName);
    map.set("127.0.0.1", localName);

    // Also map this machine's LAN IPs to the local device name
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      if (!iface) continue;
      for (const addr of iface) {
        if (!addr.internal) map.set(addr.address, localName);
      }
    }
  }

  return map;
}

const HOSTNAME_TO_DEVICE = buildHostnameToDeviceMap();

/**
 * Derive the display host from a service's URL.
 * Reverse-looks up the URL hostname against the DEVICES table
 * to return the friendly device name (e.g. "Synology NAS").
 * Falls back to the configured `device` field when no match is found.
 */
function deriveHost(url: string, svc: ProjectEntry) {
  if (!url) return DEVICES[svc.device]?.name || svc.device || "Unknown";
  try {
    const parsed = new URL(url);
    return HOSTNAME_TO_DEVICE.get(parsed.hostname)
      || DEVICES[svc.device]?.name
      || svc.device
      || "Unknown";
  } catch {
    return DEVICES[svc.device]?.name || svc.device || "Unknown";
  }
}

/**
 * Rewrite a URL to use localhost when health-checking a service on
 * the same device.  WSL2 can reach Windows apps via localhost but
 * not always via the LAN IP (apps that bind to 127.0.0.1 only).
 */
function toLocalHealthUrl(url: string, svc: ProjectEntry) {
  if (!LOCAL_DEVICE_KEY || svc.device !== LOCAL_DEVICE_KEY) return url;
  try {
    const parsed = new URL(url);
    parsed.hostname = "localhost";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Service status snapshot.
 * @typedef {object} ServiceStatus
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {"Production"|"Development"} environment
 * @property {string} device - Resolved device name (e.g. "Workstation", "Synology NAS")
 * @property {string|null} repo - GitHub repository URL
 * @property {boolean} healthy
 * @property {number|null} responseTimeMs
 * @property {object|null} metadata - Root endpoint JSON (version, endpoints, etc.)
 * @property {string|null} error
 * @property {string} checkedAt - ISO timestamp
 */


const statusCache = new Map();

export default class ServiceRegistryService {
  /**
   * Get all registered services with their current status.

   */
  static list() {
    return Object.entries(PROJECTS).map(([id, svc]) => {
      const cached = statusCache.get(id);
      return cached || {
        id,
        name: svc.name,
        url: svc.url,
        port: svc.port || null,
        environment: svc.environment,
        visibility: svc.visibility,
        projectType: svc.projectType || null,
        description: svc.description || null,
        db: svc.db || null,
        minioBucket: svc.minioBucket || null,
        repo: svc.repo || null,
        npmPackage: svc.npmPackage || null,
        device: deriveHost(svc.url, svc),
        domain: svc.domain || null,
        dependsOn: svc.dependsOn || [],
        deployTier: svc.deployTier ?? null,
        essential: svc.essential || false,
        restartable: !!svc.dockerProject,
        dockerProject: svc.dockerProject || null,
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: "Not yet checked",
        checkedAt: null,
      };
    });
  }

  /**
   * Poll all services and update the status cache.

   */
  static async checkAll() {
    const results = await Promise.all(
      Object.entries(PROJECTS).map(([id, svc]) =>
        ServiceRegistryService._checkService(id, svc),
      ),
    );

    for (const status of results) {
      statusCache.set(status.id, status);
    }

    return results;
  }

  /**
   * Maximum number of retry attempts for a failed health check.
   * Retries help catch services that are still initializing after startup.
   */
  static HEALTH_CHECK_RETRIES = 1;

  /** Delay (ms) between retry attempts. */
  static HEALTH_CHECK_RETRY_DELAY_MS = 1500;

  /**
   * Poll a single service's root health endpoint.
   * Retries once after a short delay if the first attempt fails,
   * which handles the window where a service (e.g. LM Studio) is
   * still binding its HTTP listener after startup.

   * @param {{ name: string, url: string }} svc

   */
  static async _checkService(id: string, svc: ProjectEntry) {
    if (!svc.url) {
      return {
        id,
        name: svc.name,
        url: "",
        port: svc.port || null,
        environment: svc.environment,
        visibility: svc.visibility,
        projectType: svc.projectType || null,
        description: svc.description || null,
        db: svc.db || null,
        minioBucket: svc.minioBucket || null,
        repo: svc.repo || null,
        npmPackage: svc.npmPackage || null,
        device: deriveHost(svc.url, svc),
        domain: svc.domain || null,
        dependsOn: svc.dependsOn || [],
        deployTier: svc.deployTier ?? null,
        essential: svc.essential || false,
        restartable: !!svc.dockerProject,
        dockerProject: svc.dockerProject || null,
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: "No URL configured",
        checkedAt: new Date().toISOString(),
      };
    }

    const wasPreviouslyDown = statusCache.has(id) && !statusCache.get(id).healthy;
    const maxAttempts = wasPreviouslyDown
      ? 1 + ServiceRegistryService.HEALTH_CHECK_RETRIES
      : 1;

    let lastResult: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, ServiceRegistryService.HEALTH_CHECK_RETRY_DELAY_MS));
      }

      lastResult = await ServiceRegistryService._attemptHealthCheck(id, svc);

      if (lastResult.healthy) {
        if (attempt > 1) {
          logger.info(`[ServiceRegistry] ${svc.name} recovered on retry ${attempt - 1}`);
        }
        return lastResult;
      }
    }

    return lastResult;
  }

  /**
   * Single health-check attempt against a service endpoint.


   */
  static async _attemptHealthCheck(id: string, svc: ProjectEntry) {
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        HEALTH_CHECK_TIMEOUT_MS,
      );

      const publicHealthUrl = `${svc.url}${svc.healthPath || "/"}`;
      const healthUrl = toLocalHealthUrl(publicHealthUrl, svc);
      const response = await fetch(healthUrl, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout);

      const responseTimeMs = Date.now() - start;
      let metadata: Record<string, unknown> | null = null;

      try {
        metadata = await response.json() as Record<string, unknown>;
      } catch {
        // Not all services return JSON at root
      }

      return {
        id,
        name: svc.name,
        url: svc.url,
        port: svc.port || null,
        environment: svc.environment,
        visibility: svc.visibility,
        projectType: svc.projectType || null,
        description: svc.description || null,
        db: svc.db || null,
        minioBucket: svc.minioBucket || null,
        repo: svc.repo || null,
        npmPackage: svc.npmPackage || null,
        device: deriveHost(svc.url, svc),
        domain: svc.domain || null,
        dependsOn: svc.dependsOn || [],
        deployTier: svc.deployTier ?? null,
        essential: svc.essential || false,
        restartable: !!svc.dockerProject,
        dockerProject: svc.dockerProject || null,
        healthy: response.ok,
        responseTimeMs,
        metadata,
        error: response.ok ? null : `HTTP ${response.status}`,
        checkedAt: new Date().toISOString(),
      };
    } catch (error: any) {
      const errorDetail = ServiceRegistryService._extractErrorDetail(error);
      logger.warn(`[ServiceRegistry] ${svc.name} unreachable: ${errorDetail}`);
      return {
        id,
        name: svc.name,
        url: svc.url,
        port: svc.port || null,
        environment: svc.environment,
        visibility: svc.visibility,
        projectType: svc.projectType || null,
        description: svc.description || null,
        db: svc.db || null,
        minioBucket: svc.minioBucket || null,
        repo: svc.repo || null,
        npmPackage: svc.npmPackage || null,
        device: deriveHost(svc.url, svc),
        domain: svc.domain || null,
        dependsOn: svc.dependsOn || [],
        deployTier: svc.deployTier ?? null,
        essential: svc.essential || false,
        restartable: !!svc.dockerProject,
        dockerProject: svc.dockerProject || null,
        healthy: false,
        responseTimeMs: Date.now() - start,
        metadata: null,
        error: errorDetail,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Extract a meaningful error message from a fetch failure.
   * Node's undici wraps the real cause (ECONNREFUSED, EHOSTUNREACH, etc.)
   * inside error.cause, while error.message is just the opaque "fetch failed".


   */
  static _extractErrorDetail(error: any) {
    if (error.name === "AbortError") return "Timeout";

    // Dig into undici's nested cause chain for the real error code
    let cause = error.cause;
    while (cause) {
      if (cause.code) {
        const code = cause.code;
        return ERROR_CODE_LABELS[code] || `${code}: ${cause.message || error.message}`;
      }
      cause = cause.cause;
    }

    return error.message;
  }
}
