import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Services Route ─────────────────────────────────────────

import { Router, Request, Response, NextFunction } from "express";
import ServiceRegistryService from "../services/ServiceRegistryService.ts";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.ts";
import DockerStatsService from "../services/DockerStatsService.ts";
import CodeAnalysisService from "../services/CodeAnalysisService.ts";
import { PROJECTS, DEVICES, PROJECT_TYPE_COLORS, DEPLOY_TIER_COLORS, GITHUB_PAT } from "../config.ts";
import logger from "../utils/logger.ts";
import type { ProjectEntry, EnrichedDependency, TtlCache } from "../types.ts";

const router = Router();

/**
 * Resolve the device object for a project's Docker host.
 * Returns the device entry from the registry that has dockerApi configured.

 * @returns {{ id: string, device: object } | null}
 */
function resolveDockerDevice(svc: ProjectEntry) {
  const deviceId = svc.device || "synology";
  const device = DEVICES[deviceId];

  if (!device || !device.dockerApi) {
    return null;
  }

  return { id: deviceId, device };
}

/**
 * Build a lookup map (id → name) and compute the inverse dependency graph.
 * Returns both `dependsOn` (resolved to {id, name}) and `dependedOnBy`.
 */
function enrichWithDependencies(services: Record<string, unknown>[], infrastructure: Record<string, unknown>[]) {
  const all = [...services, ...infrastructure] as Array<Record<string, unknown> & { id: string; name: string; dependsOn?: Array<string | { id: string; criticality?: string }>; dependedOnBy?: EnrichedDependency[] }>;

  // id → name lookup
  const nameMap = Object.fromEntries(all.map((s) => [s.id, s.name]));

  // Normalize a dependency entry — handles raw string IDs,
  // structured { id, criticality } objects, and already-enriched
  // { id, name, criticality } objects from cached status.
  const rawId = (dep: string | { id: string }) => (typeof dep === "string" ? dep : dep.id);
  const rawCriticality = (dep: string | { id: string; criticality?: string }) =>
    typeof dep === "string" ? "required" : dep.criticality || "required";

  // Compute inverse: dependedOnBy[targetId] = [{ id, name, criticality }, ...]
  const inverseMap: Record<string, EnrichedDependency[]> = {};
  for (const item of all) {
    for (const dep of item.dependsOn || []) {
      const id = rawId(dep);
      if (!inverseMap[id]) inverseMap[id] = [];
      inverseMap[id].push({
        id: item.id,
        name: item.name,
        criticality: rawCriticality(dep),
      });
    }
  }

  // Enrich each item — resolve names and carry criticality
  for (const item of all) {
    item.dependsOn = (item.dependsOn || []).map((dep) => {
      const id = rawId(dep);
      return {
        id,
        name: nameMap[id] || id,
        criticality: rawCriticality(dep),
      };
    });
    item.dependedOnBy = inverseMap[item.id] || [];
  }

  return { services, infrastructure };
}

/**
 * GET /services
 * Returns the current health status of all registered services
 * plus infrastructure backing stores (MongoDB, MinIO, etc.).
 * If ?refresh=true, forces a fresh health check before responding.
 */
router.get("/", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    let services, infrastructure;

    if (req.query.refresh === "true") {
      [services, infrastructure] = await Promise.all([
        ServiceRegistryService.checkAll(),
        InfrastructureRegistryService.checkAll(),
      ]);
    } else {
      services = ServiceRegistryService.list();
      infrastructure = InfrastructureRegistryService.list();
    }

    const enriched = enrichWithDependencies(services, infrastructure);
    res.json({ ...enriched, projectTypeColors: PROJECT_TYPE_COLORS, deployTierColors: DEPLOY_TIER_COLORS });
  } catch (error: any) {
    next(error);
  }
}, "Services_List"));

/**
 * POST /services/check
 * Trigger a fresh health check for all services and infrastructure.
 */
router.post("/check", asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [services, infrastructure] = await Promise.all([
      ServiceRegistryService.checkAll(),
      InfrastructureRegistryService.checkAll(),
    ]);
    const enriched = enrichWithDependencies(services, infrastructure);
    res.json({ ...enriched, projectTypeColors: PROJECT_TYPE_COLORS, deployTierColors: DEPLOY_TIER_COLORS });
  } catch (error: any) {
    next(error);
  }
}, "Services_Check"));

/**
 * POST /services/:id/restart
 * Restart a containerized service via Docker Engine API.
 * Routes to the correct Docker host based on the project's device.
 */
router.post("/:id/restart", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const svc = PROJECTS[id as string];

    if (!svc) {
      return res.status(404).json({ error: `Unknown service: ${id}` });
    }

    if (!svc.dockerProject) {
      return res.status(400).json({ error: `${svc.name} is not a containerized service` });
    }

    const target = resolveDockerDevice(svc);
    if (!target) {
      return res.status(400).json({ error: `No Docker API configured for device: ${svc.device}` });
    }

    const container = svc.dockerProject;
    logger.info(`[Restart] ${svc.name} → ${target.id}:/containers/${container}/restart`);

    const result = await DockerStatsService.dockerRequest(
      target.device, "POST", `/containers/${container}/restart?t=10`,
    );

    if (result.statusCode === 204) {
      logger.success(`[Restart] ${svc.name} restarted successfully`);

      // Trigger a fresh health check after a short delay
      setTimeout(() => {
        ServiceRegistryService.checkAll().catch(() => {});
      }, 3000);

      res.json({
        success: true,
        service: svc.name,
        device: target.id,
        message: "Container restarted",
      });
    } else {
      const message = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Restart] Failed for ${svc.name}: ${message}`);
      res.status(502).json({ error: message });
    }
  } catch (error: any) {
    logger.error(`[Restart] Failed: ${error.message}`);
    next(error);
  }
}, "Services_Restart"));

/**
 * POST /services/:id/stop
 * Stop a containerized service via Docker Engine API.
 */
router.post("/:id/stop", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const svc = PROJECTS[id as string];

    if (!svc) {
      return res.status(404).json({ error: `Unknown service: ${id}` });
    }

    if (!svc.dockerProject) {
      return res.status(400).json({ error: `${svc.name} is not a containerized service` });
    }

    const target = resolveDockerDevice(svc);
    if (!target) {
      return res.status(400).json({ error: `No Docker API configured for device: ${svc.device}` });
    }

    const container = svc.dockerProject;
    logger.info(`[Stop] ${svc.name} → ${target.id}:/containers/${container}/stop`);

    const result = await DockerStatsService.dockerRequest(
      target.device, "POST", `/containers/${container}/stop?t=10`,
    );

    if (result.statusCode === 204 || result.statusCode === 304) {
      logger.success(`[Stop] ${svc.name} stopped successfully`);

      setTimeout(() => {
        ServiceRegistryService.checkAll().catch(() => {});
      }, 3000);

      res.json({
        success: true,
        service: svc.name,
        device: target.id,
        message: result.statusCode === 304 ? "Container already stopped" : "Container stopped",
      });
    } else {
      const message = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Stop] Failed for ${svc.name}: ${message}`);
      res.status(502).json({ error: message });
    }
  } catch (error: any) {
    logger.error(`[Stop] Failed: ${error.message}`);
    next(error);
  }
}, "Services_Stop"));

/**
 * POST /services/:id/start
 * Start a containerized service via Docker Engine API.
 */
router.post("/:id/start", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const svc = PROJECTS[id as string];

    if (!svc) {
      return res.status(404).json({ error: `Unknown service: ${id}` });
    }

    if (!svc.dockerProject) {
      return res.status(400).json({ error: `${svc.name} is not a containerized service` });
    }

    const target = resolveDockerDevice(svc);
    if (!target) {
      return res.status(400).json({ error: `No Docker API configured for device: ${svc.device}` });
    }

    const container = svc.dockerProject;
    logger.info(`[Start] ${svc.name} → ${target.id}:/containers/${container}/start`);

    const result = await DockerStatsService.dockerRequest(
      target.device, "POST", `/containers/${container}/start`,
    );

    if (result.statusCode === 204 || result.statusCode === 304) {
      logger.success(`[Start] ${svc.name} started successfully`);

      setTimeout(() => {
        ServiceRegistryService.checkAll().catch(() => {});
      }, 3000);

      res.json({
        success: true,
        service: svc.name,
        device: target.id,
        message: result.statusCode === 304 ? "Container already running" : "Container started",
      });
    } else {
      const message = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Start] Failed for ${svc.name}: ${message}`);
      res.status(502).json({ error: message });
    }
  } catch (error: any) {
    logger.error(`[Start] Failed: ${error.message}`);
    next(error);
  }
}, "Services_Start"));

/**
 * GET /services/:id/rollback-status
 * Check whether a :previous image tag exists for a containerized service,
 * indicating that a rollback is available.
 */
router.get("/:id/rollback-status", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const svc = PROJECTS[id as string];

    if (!svc) {
      return res.status(404).json({ error: `Unknown service: ${id}` });
    }

    if (!svc.dockerProject) {
      return res.json({ available: false, reason: "Not a containerized service" });
    }

    const target = resolveDockerDevice(svc);
    if (!target) {
      return res.json({ available: false, reason: "No Docker API configured" });
    }

    const imageName = svc.dockerProject;
    const previousTag = `${imageName}:previous`;

    try {
      const body = await DockerStatsService.dockerGet(
        target.device!,
        `/images/${encodeURIComponent(previousTag)}/json`,
        undefined
      ) as string;
      const imageInfo = JSON.parse(body);
      const created = imageInfo.Created || null;
      const size = imageInfo.Size || 0;
      const labels = imageInfo.Config?.Labels || {};

      res.json({
        available: true,
        service: svc.name,
        device: target.id,
        previousImage: {
          tag: previousTag,
          created,
          size,
          gitSha: labels["git.sha"] || null,
          gitBranch: labels["git.branch"] || null,
          buildTime: labels["build.time"] || null,
        },
      });
    } catch {
      // Image not found → 404 from Docker API
      res.json({ available: false, reason: "No previous image found" });
    }
  } catch (error: any) {
    next(error);
  }
}, "Services_RollbackStatus"));

/**
 * POST /services/:id/rollback
 * Rollback a containerized service to its :previous image tag.
 *
 * Strategy:
 *  1. Verify :previous image exists
 *  2. Re-tag current :latest → :rollback-backup
 *  3. Re-tag :previous → :latest
 *  4. Re-tag :rollback-backup → :previous (so we can roll-forward)
 *  5. Restart the container (it uses :latest)
 */
router.post("/:id/rollback", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const svc = PROJECTS[id as string];

    if (!svc) {
      return res.status(404).json({ error: `Unknown service: ${id}` });
    }

    if (!svc.dockerProject) {
      return res.status(400).json({ error: `${svc.name} is not a containerized service` });
    }

    const target = resolveDockerDevice(svc);
    if (!target) {
      return res.status(400).json({ error: `No Docker API configured for device: ${svc.device}` });
    }

    const imageName = svc.dockerProject;
    const latestTag = `${imageName}:latest`;
    const previousTag = `${imageName}:previous`;
    const backupTag = `${imageName}:rollback-backup`;

    logger.info(`[Rollback] ${svc.name} → checking for :previous image`);

    // 1. Verify :previous exists
    try {
      await DockerStatsService.dockerGet(
        target.device,
        `/images/${encodeURIComponent(previousTag)}/json`,
        undefined
      );
    } catch {
      return res.status(400).json({ error: "No previous image available for rollback" });
    }

    // 2. Tag current :latest → :rollback-backup
    const tagBackup = await DockerStatsService.dockerRequest(
      target.device, "POST",
      `/images/${encodeURIComponent(latestTag)}/tag?repo=${encodeURIComponent(imageName)}&tag=rollback-backup`,
    );
    if (tagBackup.statusCode !== 201) {
      logger.warn(`[Rollback] Failed to back up current :latest (${tagBackup.statusCode}), proceeding anyway`);
    }

    // 3. Tag :previous → :latest
    const tagLatest = await DockerStatsService.dockerRequest(
      target.device, "POST",
      `/images/${encodeURIComponent(previousTag)}/tag?repo=${encodeURIComponent(imageName)}&tag=latest`,
    );
    if (tagLatest.statusCode !== 201) {
      const message = tryParseDockerError(tagLatest.body) || `Failed to tag :previous as :latest (${tagLatest.statusCode})`;
      logger.error(`[Rollback] ${message}`);
      return res.status(502).json({ error: message });
    }

    // 4. Tag :rollback-backup → :previous (enable roll-forward)
    const tagPrevious = await DockerStatsService.dockerRequest(
      target.device, "POST",
      `/images/${encodeURIComponent(backupTag)}/tag?repo=${encodeURIComponent(imageName)}&tag=previous`,
    );
    if (tagPrevious.statusCode !== 201) {
      logger.warn(`[Rollback] Failed to set new :previous for roll-forward (${tagPrevious.statusCode})`);
    }

    // Cleanup :rollback-backup tag
    await DockerStatsService.dockerRequest(
      target.device, "DELETE",
      `/images/${encodeURIComponent(backupTag)}?noprune=true`,
    ).catch(() => {});

    // 5. Restart the container so it picks up the new :latest
    logger.info(`[Rollback] Restarting ${svc.name} with rolled-back image`);
    const restartResult = await DockerStatsService.dockerRequest(
      target.device, "POST", `/containers/${svc.dockerProject}/restart?t=10`,
    );

    if (restartResult.statusCode === 204) {
      logger.success(`[Rollback] ${svc.name} rolled back and restarted successfully`);

      setTimeout(() => {
        ServiceRegistryService.checkAll().catch(() => {});
      }, 3000);

      res.json({
        success: true,
        service: svc.name,
        device: target.id,
        message: "Rolled back to previous image and restarted",
      });
    } else {
      const message = tryParseDockerError(restartResult.body) || `Restart after rollback failed: ${restartResult.statusCode}`;
      logger.error(`[Rollback] ${message}`);
      res.status(502).json({ error: message });
    }
  } catch (error: any) {
    logger.error(`[Rollback] Failed: ${error.message}`);
    next(error);
  }
}, "Services_Rollback"));

/**
 * GET /services/sizes
 * Returns GitHub repository sizes for all projects with a repo field.
 * Results are cached for 5 minutes to avoid GitHub API rate limits.
 */
const SIZE_CACHE_TTL_MS = 5 * 60 * 1000;

function createTtlCache<T>(ttlMs: number): TtlCache<T> {
  let cache: T | null = null;
  let cacheAt = 0;
  return {
    get: (now: number) => {
      if (cache && now - cacheAt < ttlMs) return cache;
      return null;
    },
    set: (data: T, now: number) => {
      cache = data;
      cacheAt = now;
    }
  };
}

const sizeCache = createTtlCache<{ sizes: Record<string, { sizeKB: number; sizeBytes: number }>; fetchedAt: string }>(SIZE_CACHE_TTL_MS);

router.get("/sizes", asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const now = Date.now();
    const cachedSize = sizeCache.get(now);
    if (cachedSize) {
      return res.json(cachedSize);
    }

    const entries = Object.entries(PROJECTS).filter(([, svc]) => svc.repo);
    const sizes: Record<string, { sizeKB: number; sizeBytes: number }> = {};

    await Promise.allSettled(
      entries.map(async ([id, svc]) => {
        const match = svc.repo?.match(/github\.com\/(.+?)(?:\.git)?$/);
        if (!match) return;

        const slug = match[1];
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
          const headers: Record<string, string> = {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "portal-service",
          };
          if (GITHUB_PAT) {
            headers.Authorization = `Bearer ${GITHUB_PAT}`;
          }

          const resp = await fetch(`https://api.github.com/repos/${slug}`, {
            headers,
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (!resp.ok) {
            if (!GITHUB_PAT && resp.status === 403) {
              logger.warn(`[Sizes] GitHub 403 for ${slug} — set GITHUB_PAT for private repo access`);
            }
            return;
          }

          const data = await resp.json() as Record<string, number>;
          sizes[id] = {
            sizeKB: data.size,
            sizeBytes: data.size * 1024,
          };
        } catch {
          clearTimeout(timeout);
        }
      }),
    );

    const response = { sizes, fetchedAt: new Date().toISOString() };
    sizeCache.set(response, now);

    res.json(response);
  } catch (error: any) {
    next(error);
  }
}, "Services_Sizes"));

/**
 * GET /services/analysis
 * Returns auto-detected ecosystem dependencies:
 *   - Library imports (from package.json)
 *   - API call references (from config files)
 *   - Repository sizes (from GitHub API)
 * Results are cached for 15 minutes. Pass ?refresh=true to force re-analysis.
 */
router.get("/analysis", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    const result = await CodeAnalysisService.analyze(forceRefresh);
    res.json(result);
  } catch (error: any) {
    next(error);
  }
}, "Services_Analysis"));

/**
 * GET /services/languages
 * Returns GitHub language breakdown for each project with a repo URL.
 * Uses the GitHub Linguist-powered /repos/{owner}/{repo}/languages endpoint.
 * Results are cached for 15 minutes to stay within API rate limits.
 */
const LANG_CACHE_TTL_MS = 15 * 60 * 1000;

interface LanguageBreakdown {
  primary: string | null;
  breakdown: Array<{ language: string; bytes: number; percent: number }>;
  totalBytes: number;
}

const langCache = createTtlCache<{ languages: Record<string, LanguageBreakdown>; fetchedAt: string }>(LANG_CACHE_TTL_MS);

router.get("/languages", asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const now = Date.now();
    const cached = langCache.get(now);
    if (cached) {
      return res.json(cached);
    }

    const entries = Object.entries(PROJECTS).filter(([, svc]) => svc.repo);
    const languages: Record<string, LanguageBreakdown> = {};

    await Promise.allSettled(
      entries.map(async ([id, svc]) => {
        const match = svc.repo?.match(/github\.com\/(.+?)(?:\.git)?$/);
        if (!match) return;

        const slug = match[1];
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
          const headers: Record<string, string> = {
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "portal-service",
          };
          if (GITHUB_PAT) {
            headers.Authorization = `Bearer ${GITHUB_PAT}`;
          }

          const resp = await fetch(`https://api.github.com/repos/${slug}/languages`, {
            headers,
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (!resp.ok) {
            if (!GITHUB_PAT && resp.status === 403) {
              logger.warn(`[Languages] GitHub 403 for ${slug} — set GITHUB_PAT for private repo access`);
            }
            return;
          }

          const data = await resp.json() as Record<string, number>;
          const totalBytes = Object.values(data).reduce((sum, b) => sum + b, 0);

          // Sort by bytes descending
          const sorted = Object.entries(data).sort(([, a], [, b]) => b - a);
          const primary = sorted.length > 0 ? sorted[0][0] : null;

          languages[id] = {
            primary,
            breakdown: sorted.map(([lang, bytes]) => ({
              language: lang,
              bytes,
              percent: totalBytes > 0 ? Math.round((bytes / totalBytes) * 1000) / 10 : 0,
            })),
            totalBytes,
          };
        } catch {
          clearTimeout(timeout);
        }
      }),
    );

    const response = { languages, fetchedAt: new Date().toISOString() };
    langCache.set(response, now);

    res.json(response);
  } catch (error: any) {
    next(error);
  }
}, "Services_Languages"));

/**
 * Try to extract a message from a Docker API error response body.
 */
function tryParseDockerError(body: string) {
  try {
    return JSON.parse(body).message;
  } catch {
    return null;
  }
}

export default router;
