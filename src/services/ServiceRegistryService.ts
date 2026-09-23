import { sleep } from "@rodrigo-barraza/utilities-library";
import type { ProjectEntry, ServiceStatus } from "../types.ts";
import { PROJECTS, HEALTH_CHECK_TIMEOUT_MS } from "../config.ts";
import logger from "../utils/logger.ts";
import { DeviceResolver } from "../utils/DeviceResolver.ts";

const ERROR_CODE_LABELS: Record<string, string> = {
  ECONNREFUSED: "Connection refused",
  EHOSTUNREACH: "Host unreachable",
  ENETUNREACH: "Network unreachable",
  ECONNRESET: "Connection reset",
  ETIMEDOUT: "Connection timed out",
  ENOTFOUND: "DNS lookup failed",
  EPIPE: "Broken pipe",
};

type ProbeFields = Pick<ServiceStatus, "healthy" | "responseTimeMs" | "metadata" | "error" | "checkedAt">;

const statusCache = new Map<string, ServiceStatus>();

// Consecutive fully-failed check rounds per service, used to debounce
// healthy→down transitions (see _checkService).
const consecutiveFailedRounds = new Map<string, number>();

let roundInflight: Promise<ServiceStatus[]> | null = null;
let recheckTimer: ReturnType<typeof setTimeout> | null = null;

// A container action settles a few seconds after Docker acknowledges it.
const POST_ACTION_RECHECK_DELAY_MS = 3_000;

/** A project's registry fields, plus the outcome of its latest probe. */
function toStatus(id: string, service: ProjectEntry, probe: ProbeFields): ServiceStatus {
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
    // Lifecycle actions (restart/stop/start/rollback) act on the project's
    // Docker container — only containerized projects have one.
    restartable: Boolean(service.dockerProject),
    dockerProject: service.dockerProject || null,
    // Lets the client open the project's Web Analytics tab without a
    // second lookup against /google-analytics/properties.
    analyticsPropertyId: service.analyticsPropertyId,
    ...probe,
  };
}

export default class ServiceRegistryService {
  public static HEALTH_CHECK_RETRIES = 1;
  public static HEALTH_CHECK_RETRY_DELAY_MS = 1500;
  // A healthy service must fail this many consecutive rounds (with retries
  // exhausted each round) before it is reported as down.
  public static UNHEALTHY_AFTER_ROUNDS = 2;

  public static list(): ServiceStatus[] {
    return Object.entries(PROJECTS).map(
      ([id, service]) =>
        statusCache.get(id) ??
        toStatus(id, service, {
          healthy: false,
          responseTimeMs: null,
          metadata: null,
          error: "Not yet checked",
          checkedAt: null,
        }),
    );
  }

  /**
   * Probe every registered project. Concurrent callers — the 60s loop,
   * `?refresh=true`, post-action rechecks, registry reloads — share one
   * round: overlapping rounds would each count toward the healthy→down
   * debounce and flip a service down after a single real failure.
   */
  public static checkAll(): Promise<ServiceStatus[]> {
    roundInflight ??= ServiceRegistryService._runRound().finally(() => {
      roundInflight = null;
    });
    return roundInflight;
  }

  /**
   * Re-probe shortly after a lifecycle action so the UI sees the new
   * state before the next 60s tick. A burst of actions queues one recheck.
   */
  public static scheduleRecheck(delayMs: number = POST_ACTION_RECHECK_DELAY_MS): void {
    if (recheckTimer) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      ServiceRegistryService.checkAll().catch(() => {});
    }, delayMs);
    recheckTimer.unref();
  }

  private static async _runRound(): Promise<ServiceStatus[]> {
    const projects = Object.entries(PROJECTS);
    const results = await Promise.all(
      projects.map(([id, service]) => ServiceRegistryService._checkService(id, service)),
    );

    // Projects dropped from the registry leave no cached state behind.
    const liveIds = new Set(projects.map(([id]) => id));
    for (const id of statusCache.keys()) {
      if (!liveIds.has(id)) statusCache.delete(id);
    }
    for (const id of consecutiveFailedRounds.keys()) {
      if (!liveIds.has(id)) consecutiveFailedRounds.delete(id);
    }

    for (const status of results) {
      statusCache.set(status.id, status);
    }
    return results;
  }

  public static async _checkService(id: string, service: ProjectEntry): Promise<ServiceStatus> {
    if (!service.url) {
      return toStatus(id, service, {
        healthy: false,
        responseTimeMs: null,
        metadata: null,
        error: "No URL configured",
        checkedAt: new Date().toISOString(),
      });
    }

    const maxAttempts = 1 + ServiceRegistryService.HEALTH_CHECK_RETRIES;
    let lastResult: ServiceStatus | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await sleep(ServiceRegistryService.HEALTH_CHECK_RETRY_DELAY_MS);
      }

      lastResult = await ServiceRegistryService._attemptHealthCheck(id, service);

      if (lastResult.healthy) {
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
      };
    }

    return lastResult!;
  }

  public static async _attemptHealthCheck(id: string, service: ProjectEntry): Promise<ServiceStatus> {
    const start = Date.now();
    const healthUrl = DeviceResolver.toLocalHealthUrl(`${service.url}${service.healthPath || "/"}`, service.device);

    try {
      // One deadline for headers AND body — a server that sends headers
      // then stalls the body can't hang the round (and with it every
      // caller sharing the in-flight round).
      const response = await fetch(healthUrl, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      const responseTimeMs = Date.now() - start;

      let metadata: Record<string, unknown> | null = null;
      try {
        metadata = (await response.json()) as Record<string, unknown>;
      } catch {
        // Not all services return JSON at their health path
      }

      return toStatus(id, service, {
        healthy: response.ok,
        responseTimeMs,
        metadata,
        error: response.ok ? null : `HTTP ${response.status}`,
        checkedAt: new Date().toISOString(),
      });
    } catch (error: unknown) {
      const errorDetail = ServiceRegistryService._extractErrorDetail(error);
      logger.warn(`[ServiceRegistry] ${service.name} unreachable: ${errorDetail}`);
      return toStatus(id, service, {
        healthy: false,
        responseTimeMs: Date.now() - start,
        metadata: null,
        error: errorDetail,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  public static _extractErrorDetail(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    if (error.name === "AbortError" || error.name === "TimeoutError") return "Timeout";

    // fetch wraps the socket error: TypeError("fetch failed", { cause })
    let current: unknown = error;
    while (current && typeof current === "object" && "cause" in current) {
      const cause = (current as { cause: unknown }).cause;
      if (cause && typeof cause === "object") {
        const causeObject = cause as { code?: string; message?: string };
        if (causeObject.code) {
          return ERROR_CODE_LABELS[causeObject.code] || `${causeObject.code}: ${causeObject.message || error.message}`;
        }
      }
      current = cause;
    }

    return error.message;
  }
}
