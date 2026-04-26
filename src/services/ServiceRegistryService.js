// ============================================================
// Portal API — Service Registry Service
// ============================================================
// Static registry of all Sun ecosystem services.
// Polls health endpoints and tracks status.
// ============================================================

import { SERVICES, DEVICES, HEALTH_CHECK_TIMEOUT_MS } from "../config.js";
import logger from "../utils/logger.js";

/**
 * Service status snapshot.
 * @typedef {object} ServiceStatus
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {"Production"|"Development"} stage
 * @property {string} host - Resolved device name (e.g. "Workstation", "Raspberry Pi")
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
        stage: svc.stage,
        visibility: svc.visibility,
        repo: svc.repo || null,
        host: DEVICES[svc.device]?.name || svc.device || "Unknown",
        dependsOn: svc.dependsOn || [],
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
        stage: svc.stage,
        visibility: svc.visibility,
        repo: svc.repo || null,
        host: DEVICES[svc.device]?.name || svc.device || "Unknown",
        dependsOn: svc.dependsOn || [],
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

      const healthUrl = `${svc.url}${svc.healthPath || "/"}`;
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
        stage: svc.stage,
        visibility: svc.visibility,
        repo: svc.repo || null,
        host: DEVICES[svc.device]?.name || svc.device || "Unknown",
        dependsOn: svc.dependsOn || [],
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
        stage: svc.stage,
        visibility: svc.visibility,
        repo: svc.repo || null,
        host: DEVICES[svc.device]?.name || svc.device || "Unknown",
        dependsOn: svc.dependsOn || [],
        healthy: false,
        responseTimeMs: Date.now() - start,
        metadata: null,
        error: err.name === "AbortError" ? "Timeout" : err.message,
        checkedAt: new Date().toISOString(),
      };
    }
  }
}
