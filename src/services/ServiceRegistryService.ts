import { sleep } from "@rodrigo-barraza/utilities-library";
import type { ProjectEntry, DependencyRef } from "../types.ts";
import { PROJECTS, HEALTH_CHECK_TIMEOUT_MS } from "../config.ts";
import logger from "../utils/logger.ts";
import { ERROR_CODE_LABELS } from "../types.ts";
import { DeviceResolver } from "../utils/DeviceResolver.ts";

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
  minioBucket: string | string[] | null;
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

// Consecutive fully-failed check rounds per service, used to debounce
// healthy→down transitions (see _checkService).
const consecutiveFailedRounds = new Map<string, number>();

export default class ServiceRegistryService {
  public static list(): ServiceStatus[] {
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
        device: DeviceResolver.deriveHost(service.url, service.device),
        domain: service.domain || null,
        dependsOn: service.dependsOn || [],
        deployTier: service.deployTier ?? null,
        essential: service.essential || false,
        restartable: !service.dockerProject,
        dockerProject: service.dockerProject || null,
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: "Not yet checked",
        checkedAt: null,
      };
    });
  }

  public static async checkAll() {
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

  public static HEALTH_CHECK_RETRIES = 1;
  public static HEALTH_CHECK_RETRY_DELAY_MS = 1500;
  // A healthy service must fail this many consecutive rounds (with retries
  // exhausted each round) before it is reported as down.
  public static UNHEALTHY_AFTER_ROUNDS = 2;

  public static async _checkService(id: string, service: ProjectEntry) {
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
        device: DeviceResolver.deriveHost(service.url, service.device),
        domain: service.domain || null,
        dependsOn: service.dependsOn || [],
        deployTier: service.deployTier ?? null,
        essential: service.essential || false,
        restartable: !service.dockerProject,
        dockerProject: service.dockerProject || null,
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: "No URL configured",
        checkedAt: new Date().toISOString(),
      } as ServiceStatus;
    }

    const maxAttempts = 1 + ServiceRegistryService.HEALTH_CHECK_RETRIES;

    let lastResult: ServiceStatus | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await sleep(ServiceRegistryService.HEALTH_CHECK_RETRY_DELAY_MS);
      }

      lastResult = await ServiceRegistryService._attemptHealthCheck(id, service);

      if (lastResult?.healthy) {
        consecutiveFailedRounds.delete(id);
        if (attempt > 1) {
          logger.info(`[ServiceRegistry] ${service.name} recovered on retry ${attempt - 1}`);
        }
        return lastResult;
      }
    }

    // Debounce healthy→down: one bad round (e.g. a host-wide stall that
    // times out every probe at once) keeps the last healthy status; only
    // UNHEALTHY_AFTER_ROUNDS consecutive failed rounds flip the flag.
    const failedRounds = (consecutiveFailedRounds.get(id) || 0) + 1;
    consecutiveFailedRounds.set(id, failedRounds);

    const previous = statusCache.get(id);
    if (previous?.healthy && failedRounds < ServiceRegistryService.UNHEALTHY_AFTER_ROUNDS) {
      logger.warn(
        `[ServiceRegistry] ${service.name} failed round ${failedRounds}/${ServiceRegistryService.UNHEALTHY_AFTER_ROUNDS} (${lastResult?.error}) — holding healthy until confirmed`,
      );
      return {
        ...previous,
        error: `Unconfirmed failure (${failedRounds}/${ServiceRegistryService.UNHEALTHY_AFTER_ROUNDS}): ${lastResult?.error}`,
        checkedAt: lastResult?.checkedAt ?? previous.checkedAt,
      } as ServiceStatus;
    }

    return lastResult as ServiceStatus;
  }

  public static async _attemptHealthCheck(id: string, service: ProjectEntry) {
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        HEALTH_CHECK_TIMEOUT_MS,
      );

      const publicHealthUrl = `${service.url}${service.healthPath || "/"}`;
      const healthUrl = DeviceResolver.toLocalHealthUrl(publicHealthUrl, service.device);
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
        device: DeviceResolver.deriveHost(service.url, service.device),
        domain: service.domain || null,
        dependsOn: service.dependsOn || [],
        deployTier: service.deployTier ?? null,
        essential: service.essential || false,
        restartable: !service.dockerProject,
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
        device: DeviceResolver.deriveHost(service.url, service.device),
        domain: service.domain || null,
        dependsOn: service.dependsOn || [],
        deployTier: service.deployTier ?? null,
        essential: service.essential || false,
        restartable: !service.dockerProject,
        dockerProject: service.dockerProject || null,
        healthy: false,
        responseTimeMs: Date.now() - start,
        metadata: null,
        error: errorDetail,
        checkedAt: new Date().toISOString(),
      } as ServiceStatus;
    }
  }

  public static _extractErrorDetail(error: unknown) {
    if (error instanceof Error) {
      if (error.name === "AbortError") return "Timeout";

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
