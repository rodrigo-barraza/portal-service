// ============================================================
// Portal API — Service Registry Service
// ============================================================
// Static registry of all Sun ecosystem services.
// Polls health endpoints and tracks status.
// ============================================================

import os from "os";
import { SERVICES, DEVICES, HEALTH_CHECK_TIMEOUT_MS } from "../config.js";
import logger from "../utils/logger.js";

/**
 * Detect the device key that this API instance is running on.
 * Matches the machine's LAN IPs against DEVICES hostnames.
 */
function detectLocalDevice() {
  const interfaces = os.networkInterfaces();
  const localIPs = new Set();
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (!addr.internal) localIPs.add(addr.address);
    }
  }
  localIPs.add("localhost");
  localIPs.add("127.0.0.1");

  for (const [key, device] of Object.entries(DEVICES)) {
    if (localIPs.has(device.hostname)) return key;
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
function deriveHost(url, svc) {
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
function toLocalHealthUrl(url, svc) {
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

/** @type {Map<string, ServiceStatus>} */
const statusCache = new Map();

export default class ServiceRegistryService {
  /**
   * Get all registered services with their current status.
   * @returns {ServiceStatus[]}
   */
  static list() {
    return Object.entries(SERVICES).map(([id, svc]) => {
      const cached = statusCache.get(id);
      return cached || {
        id,
        name: svc.name,
        url: svc.url,
        environment: svc.environment,
        visibility: svc.visibility,
        serviceType: svc.serviceType || null,
        repo: svc.repo || null,
        device: deriveHost(svc.url, svc),
        hostname: svc.hostname || null,
        dependsOn: svc.dependsOn || [],
        restartable: !!svc.dockerProject,
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
   * @returns {Promise<ServiceStatus[]>}
   */
  static async checkAll() {
    const results = await Promise.all(
      Object.entries(SERVICES).map(([id, svc]) =>
        ServiceRegistryService._checkService(id, svc),
      ),
    );

    for (const status of results) {
      statusCache.set(status.id, status);
    }

    return results;
  }

  /**
   * Poll a single service's root health endpoint.
   * @param {string} id
   * @param {{ name: string, url: string }} svc
   * @returns {Promise<ServiceStatus>}
   */
  static async _checkService(id, svc) {
    if (!svc.url) {
      return {
        id,
        name: svc.name,
        url: "",
        environment: svc.environment,
        visibility: svc.visibility,
        serviceType: svc.serviceType || null,
        repo: svc.repo || null,
        device: deriveHost(svc.url, svc),
        hostname: svc.hostname || null,
        dependsOn: svc.dependsOn || [],
        restartable: !!svc.dockerProject,
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: "No URL configured",
        checkedAt: new Date().toISOString(),
      };
    }

    const start = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        HEALTH_CHECK_TIMEOUT_MS,
      );

      const publicHealthUrl = `${svc.url}${svc.healthPath || "/"}`;
      const healthUrl = toLocalHealthUrl(publicHealthUrl, svc);
      const res = await fetch(healthUrl, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout);

      const responseTimeMs = Date.now() - start;
      let metadata = null;

      try {
        metadata = await res.json();
      } catch {
        // Not all services return JSON at root
      }

      return {
        id,
        name: svc.name,
        url: svc.url,
        environment: svc.environment,
        visibility: svc.visibility,
        serviceType: svc.serviceType || null,
        repo: svc.repo || null,
        device: deriveHost(svc.url, svc),
        hostname: svc.hostname || null,
        dependsOn: svc.dependsOn || [],
        restartable: !!svc.dockerProject,
        healthy: res.ok,
        responseTimeMs,
        metadata,
        error: res.ok ? null : `HTTP ${res.status}`,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      logger.warn(`[ServiceRegistry] ${svc.name} unreachable: ${err.message}`);
      return {
        id,
        name: svc.name,
        url: svc.url,
        environment: svc.environment,
        visibility: svc.visibility,
        serviceType: svc.serviceType || null,
        repo: svc.repo || null,
        device: deriveHost(svc.url, svc),
        hostname: svc.hostname || null,
        dependsOn: svc.dependsOn || [],
        restartable: !!svc.dockerProject,
        healthy: false,
        responseTimeMs: Date.now() - start,
        metadata: null,
        error: err.name === "AbortError" ? "Timeout" : err.message,
        checkedAt: new Date().toISOString(),
      };
    }
  }
}
