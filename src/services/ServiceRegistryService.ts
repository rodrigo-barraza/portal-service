import type { ProjectEntry, DependencyRef } from "../types.ts";
// ─── Service Registry Service ───────────────────────────────

import os from "os";
import { PROJECTS, DEVICES, HEALTH_CHECK_TIMEOUT_MS } from "../config.ts";
import logger from "../utils/logger.ts";
import { ERROR_CODE_LABELS } from "../types.ts";

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

function deriveHost(url: string, service: ProjectEntry) {
  if (!url) return DEVICES[service.device]?.name || service.device || "Unknown";
  try {
    const parsed = new URL(url);
    return HOSTNAME_TO_DEVICE.get(parsed.hostname)
      || DEVICES[service.device]?.name
      || service.device
      || "Unknown";
  } catch {
    return DEVICES[service.device]?.name || service.device || "Unknown";
  }
}

function toLocalHealthUrl(url: string, service: ProjectEntry) {
  if (!LOCAL_DEVICE_KEY || service.device !== LOCAL_DEVICE_KEY) return url;
  try {
    const parsed = new URL(url);
    parsed.hostname = "localhost";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

export type ServiceStatus = {
  id: string;
  name: string;
  url: string;
  port: number | null;
  environment: string;
  visibility: string;
  projectType: string | null;
  description: string | null;
  db: string | null;
  minioBucket: string | null;
  repo: string | null;
  npmPackage: string | null;
  device: string;
  domain: string | null;
  dependsOn: DependencyRef[];
  deployTier: number | null;
  essential: boolean;
  restartable: boolean;
  dockerProject: string | null;
  healthy: boolean;
  responseTimeMs: number | null;
  metadata: Record<string, unknown> | null;
  error: string | null;
  checkedAt: string | null;
}

const statusCache = new Map<string, ServiceStatus>();

export default class ServiceRegistryService {
    static list(): ServiceStatus[] {
    return Object.entries(PROJECTS).map(([id, service]) => {
      const cached = statusCache.get(id);
      return cached || {
        id,
        name: service.name,
        url: service.url,
        port: service.port || null,
        environment: service.environment,
        visibility: service.visibility,
        projectType: service.projectType || null,
        description: service.description || null,
        db: service.db || null,
        minioBucket: service.minioBucket || null,
        repo: service.repo || null,
        npmPackage: service.npmPackage || null,
        device: deriveHost(service.url, service),
        domain: service.domain || null,
        dependsOn: service.dependsOn || [],
        deployTier: service.deployTier ?? null,
        essential: service.essential || false,
        restartable: !!service.dockerProject,
        dockerProject: service.dockerProject || null,
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: "Not yet checked",
        checkedAt: null,
      };
    });
  }

    static async checkAll() {
    const results = await Promise.all(
      Object.entries(PROJECTS).map(([id, service]) =>
        ServiceRegistryService._checkService(id, service),
      ),
    );

    for (const status of results) {
      statusCache.set(status.id, status);
    }

    return results;
  }

    static HEALTH_CHECK_RETRIES = 1;

    static HEALTH_CHECK_RETRY_DELAY_MS = 1500;

    static async _checkService(id: string, service: ProjectEntry) {
    if (!service.url) {
      return {
        id,
        name: service.name,
        url: "",
        port: service.port || null,
        environment: service.environment,
        visibility: service.visibility,
        projectType: service.projectType || null,
        description: service.description || null,
        db: service.db || null,
        minioBucket: service.minioBucket || null,
        repo: service.repo || null,
        npmPackage: service.npmPackage || null,
        device: deriveHost(service.url, service),
        domain: service.domain || null,
        dependsOn: service.dependsOn || [],
        deployTier: service.deployTier ?? null,
        essential: service.essential || false,
        restartable: !!service.dockerProject,
        dockerProject: service.dockerProject || null,
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: "No URL configured",
        checkedAt: new Date().toISOString(),
      } as ServiceStatus;
    }

    const wasPreviouslyDown = statusCache.has(id) && !statusCache.get(id)?.healthy;
    const maxAttempts = wasPreviouslyDown
      ? 1 + ServiceRegistryService.HEALTH_CHECK_RETRIES
      : 1;

    let lastResult: ServiceStatus | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, ServiceRegistryService.HEALTH_CHECK_RETRY_DELAY_MS));
      }

      lastResult = await ServiceRegistryService._attemptHealthCheck(id, service);

      if (lastResult?.healthy) {
        if (attempt > 1) {
          logger.info(`[ServiceRegistry] ${service.name} recovered on retry ${attempt - 1}`);
        }
        return lastResult;
      }
    }

    return lastResult as ServiceStatus;
  }

    static async _attemptHealthCheck(id: string, service: ProjectEntry) {
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        HEALTH_CHECK_TIMEOUT_MS,
      );

      const publicHealthUrl = `${service.url}${service.healthPath || "/"}`;
      const healthUrl = toLocalHealthUrl(publicHealthUrl, service);
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
        name: service.name,
        url: service.url,
        port: service.port || null,
        environment: service.environment,
        visibility: service.visibility,
        projectType: service.projectType || null,
        description: service.description || null,
        db: service.db || null,
        minioBucket: service.minioBucket || null,
        repo: service.repo || null,
        npmPackage: service.npmPackage || null,
        device: deriveHost(service.url, service),
        domain: service.domain || null,
        dependsOn: service.dependsOn || [],
        deployTier: service.deployTier ?? null,
        essential: service.essential || false,
        restartable: !!service.dockerProject,
        dockerProject: service.dockerProject || null,
        healthy: response.ok,
        responseTimeMs,
        metadata,
        error: response.ok ? null : `HTTP ${response.status}`,
        checkedAt: new Date().toISOString(),
      } as ServiceStatus;
    } catch (error: unknown) {
      const errorDetail = ServiceRegistryService._extractErrorDetail(error);
      logger.warn(`[ServiceRegistry] ${service.name} unreachable: ${errorDetail}`);
      return {
        id,
        name: service.name,
        url: service.url,
        port: service.port || null,
        environment: service.environment,
        visibility: service.visibility,
        projectType: service.projectType || null,
        description: service.description || null,
        db: service.db || null,
        minioBucket: service.minioBucket || null,
        repo: service.repo || null,
        npmPackage: service.npmPackage || null,
        device: deriveHost(service.url, service),
        domain: service.domain || null,
        dependsOn: service.dependsOn || [],
        deployTier: service.deployTier ?? null,
        essential: service.essential || false,
        restartable: !!service.dockerProject,
        dockerProject: service.dockerProject || null,
        healthy: false,
        responseTimeMs: Date.now() - start,
        metadata: null,
        error: errorDetail,
        checkedAt: new Date().toISOString(),
      } as ServiceStatus;
    }
  }

  static _extractErrorDetail(error: unknown) {
    if (error instanceof Error) {
      if (error.name === "AbortError") return "Timeout";

      // Dig into undici's nested cause chain for the real error code
      let current: unknown = error;
      while (current && typeof current === "object" && "cause" in current) {
        const next: unknown = (current as { cause: unknown }).cause;
        if (next && typeof next === "object" && next !== null) {
          const causeObject = next as { code?: string; message?: string; cause?: unknown };
          if (causeObject.code) {
            const code = causeObject.code;
            return ERROR_CODE_LABELS[code] || `${code}: ${causeObject.message || error.message}`;
          }
        }
        current = next;
      }

      return error.message;
    }
    return String(error);
  }
}

