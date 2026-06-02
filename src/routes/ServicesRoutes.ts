import { Router, Request, Response, NextFunction } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import ServiceRegistryService from "../services/ServiceRegistryService.ts";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.ts";
import DockerStatsService from "../services/DockerStatsService.ts";
import CodeAnalysisService from "../services/CodeAnalysisService.ts";
import {
  PROJECTS,
  DEVICES,
  PROJECT_TYPE_COLORS,
  DEPLOY_TIER_COLORS,
  initializeRegistry,
} from "../config.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import type { ProjectEntry, TtlCache, VaultRegistry } from "../types.ts";
import { ServiceDependencyEnricher } from "./helpers/ServiceDependencyEnricher.ts";
import { GitHubClient } from "../wrappers/GitHubClient.ts";

const router = Router();

function resolveDockerDevice(service: ProjectEntry) {
  const deviceId = service.device || "synology";
  const device = DEVICES[deviceId];

  if (!device || !device.dockerApi) {
    return null;
  }

  return { id: deviceId, device };
}

router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
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

      const enriched = ServiceDependencyEnricher.enrich(
        services,
        infrastructure as unknown as Record<string, unknown>[]
      );
      res.json({
        ...enriched,
        projectTypeColors: PROJECT_TYPE_COLORS,
        deployTierColors: DEPLOY_TIER_COLORS,
      });
    } catch (error: unknown) {
      next(error);
    }
  }, "Services_List")
);

router.post(
  "/check",
  asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [services, infrastructure] = await Promise.all([
        ServiceRegistryService.checkAll(),
        InfrastructureRegistryService.checkAll(),
      ]);
      const enriched = ServiceDependencyEnricher.enrich(
        services,
        infrastructure as unknown as Record<string, unknown>[]
      );
      res.json({
        ...enriched,
        projectTypeColors: PROJECT_TYPE_COLORS,
        deployTierColors: DEPLOY_TIER_COLORS,
      });
    } catch (error: unknown) {
      next(error);
    }
  }, "Services_Check")
);

router.post(
  "/:id/restart",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const service = PROJECTS[String(id)];

      if (!service) {
        return res.status(404).json({ error: `Unknown service: ${id}` });
      }

      if (!service.dockerProject) {
        return res.status(400).json({ error: `${service.name} is not a containerized service` });
      }

      const target = resolveDockerDevice(service);
      if (!target) {
        return res
          .status(400)
          .json({ error: `No Docker API configured for device: ${service.device}` });
      }

      const container = service.dockerProject;
      logger.info(`[Restart] ${service.name} → ${target.id}:/containers/${container}/restart`);

      const result = await DockerStatsService.dockerRequest(
        target.device,
        "POST",
        `/containers/${container}/restart?t=10`
      );

      if (result.statusCode === 204) {
        logger.success(`[Restart] ${service.name} restarted successfully`);

        setTimeout(() => {
          ServiceRegistryService.checkAll().catch(() => {});
        }, 3000);

        res.json({
          success: true,
          service: service.name,
          device: target.id,
          message: "Container restarted",
        });
      } else {
        const message = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
        logger.error(`[Restart] Failed for ${service.name}: ${message}`);
        res.status(502).json({ error: message });
      }
    } catch (error: unknown) {
      logger.error(`[Restart] Failed: ${getErrorMessage(error)}`);
      next(error);
    }
  }, "Services_Restart")
);

router.post(
  "/:id/stop",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const service = PROJECTS[String(id)];

      if (!service) {
        return res.status(404).json({ error: `Unknown service: ${id}` });
      }

      if (!service.dockerProject) {
        return res.status(400).json({ error: `${service.name} is not a containerized service` });
      }

      const target = resolveDockerDevice(service);
      if (!target) {
        return res
          .status(400)
          .json({ error: `No Docker API configured for device: ${service.device}` });
      }

      const container = service.dockerProject;
      logger.info(`[Stop] ${service.name} → ${target.id}:/containers/${container}/stop`);

      const result = await DockerStatsService.dockerRequest(
        target.device,
        "POST",
        `/containers/${container}/stop?t=10`
      );

      if (result.statusCode === 204 || result.statusCode === 304) {
        logger.success(`[Stop] ${service.name} stopped successfully`);

        setTimeout(() => {
          ServiceRegistryService.checkAll().catch(() => {});
        }, 3000);

        res.json({
          success: true,
          service: service.name,
          device: target.id,
          message: result.statusCode === 304 ? "Container already stopped" : "Container stopped",
        });
      } else {
        const message = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
        logger.error(`[Stop] Failed for ${service.name}: ${message}`);
        res.status(502).json({ error: message });
      }
    } catch (error: unknown) {
      logger.error(`[Stop] Failed: ${getErrorMessage(error)}`);
      next(error);
    }
  }, "Services_Stop")
);

router.post(
  "/:id/start",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const service = PROJECTS[String(id)];

      if (!service) {
        return res.status(404).json({ error: `Unknown service: ${id}` });
      }

      if (!service.dockerProject) {
        return res.status(400).json({ error: `${service.name} is not a containerized service` });
      }

      const target = resolveDockerDevice(service);
      if (!target) {
        return res
          .status(400)
          .json({ error: `No Docker API configured for device: ${service.device}` });
      }

      const container = service.dockerProject;
      logger.info(`[Start] ${service.name} → ${target.id}:/containers/${container}/start`);

      const result = await DockerStatsService.dockerRequest(
        target.device,
        "POST",
        `/containers/${container}/start`
      );

      if (result.statusCode === 204 || result.statusCode === 304) {
        logger.success(`[Start] ${service.name} started successfully`);

        setTimeout(() => {
          ServiceRegistryService.checkAll().catch(() => {});
        }, 3000);

        res.json({
          success: true,
          service: service.name,
          device: target.id,
          message: result.statusCode === 304 ? "Container already running" : "Container started",
        });
      } else {
        const message = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
        logger.error(`[Start] Failed for ${service.name}: ${message}`);
        res.status(502).json({ error: message });
      }
    } catch (error: unknown) {
      logger.error(`[Start] Failed: ${getErrorMessage(error)}`);
      next(error);
    }
  }, "Services_Start")
);

router.get(
  "/:id/rollback-status",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const service = PROJECTS[String(id)];

      if (!service) {
        return res.status(404).json({ error: `Unknown service: ${id}` });
      }

      if (!service.dockerProject) {
        return res.json({ available: false, reason: "Not a containerized service" });
      }

      const target = resolveDockerDevice(service);
      if (!target) {
        return res.json({ available: false, reason: "No Docker API configured" });
      }

      const imageName = service.dockerProject;
      const previousTag = `${imageName}:previous`;

      try {
        const body = (await DockerStatsService.dockerGet(
          target.device!,
          `/images/${encodeURIComponent(previousTag)}/json`,
          undefined
        )) as string;
        const imageInfo = JSON.parse(body);
        const created = imageInfo.Created || null;
        const size = imageInfo.Size || 0;
        const labels = imageInfo.Config?.Labels || {};

        res.json({
          available: true,
          service: service.name,
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
        res.json({ available: false, reason: "No previous image found" });
      }
    } catch (error: unknown) {
      next(error);
    }
  }, "Services_RollbackStatus")
);

router.post(
  "/:id/rollback",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const service = PROJECTS[String(id)];

      if (!service) {
        return res.status(404).json({ error: `Unknown service: ${id}` });
      }

      if (!service.dockerProject) {
        return res.status(400).json({ error: `${service.name} is not a containerized service` });
      }

      const target = resolveDockerDevice(service);
      if (!target) {
        return res
          .status(400)
          .json({ error: `No Docker API configured for device: ${service.device}` });
      }

      const imageName = service.dockerProject;
      const latestTag = `${imageName}:latest`;
      const previousTag = `${imageName}:previous`;
      const backupTag = `${imageName}:rollback-backup`;

      logger.info(`[Rollback] ${service.name} → checking for :previous image`);

      try {
        await DockerStatsService.dockerGet(
          target.device,
          `/images/${encodeURIComponent(previousTag)}/json`,
          undefined
        );
      } catch {
        return res.status(400).json({ error: "No previous image available for rollback" });
      }

      const tagBackup = await DockerStatsService.dockerRequest(
        target.device,
        "POST",
        `/images/${encodeURIComponent(latestTag)}/tag?repo=${encodeURIComponent(imageName)}&tag=rollback-backup`
      );
      if (tagBackup.statusCode !== 201) {
        logger.warn(
          `[Rollback] Failed to back up current :latest (${tagBackup.statusCode}), proceeding anyway`
        );
      }

      const tagLatest = await DockerStatsService.dockerRequest(
        target.device,
        "POST",
        `/images/${encodeURIComponent(previousTag)}/tag?repo=${encodeURIComponent(imageName)}&tag=latest`
      );
      if (tagLatest.statusCode !== 201) {
        const message =
          tryParseDockerError(tagLatest.body) ||
          `Failed to tag :previous as :latest (${tagLatest.statusCode})`;
        logger.error(`[Rollback] ${message}`);
        return res.status(502).json({ error: message });
      }

      const tagPrevious = await DockerStatsService.dockerRequest(
        target.device,
        "POST",
        `/images/${encodeURIComponent(backupTag)}/tag?repo=${encodeURIComponent(imageName)}&tag=previous`
      );
      if (tagPrevious.statusCode !== 201) {
        logger.warn(
          `[Rollback] Failed to set new :previous for roll-forward (${tagPrevious.statusCode})`
        );
      }

      await DockerStatsService.dockerRequest(
        target.device,
        "DELETE",
        `/images/${encodeURIComponent(backupTag)}?noprune=true`
      ).catch(() => {});

      logger.info(`[Rollback] Restarting ${service.name} with rolled-back image`);
      const restartResult = await DockerStatsService.dockerRequest(
        target.device,
        "POST",
        `/containers/${service.dockerProject}/restart?t=10`
      );

      if (restartResult.statusCode === 204) {
        logger.success(`[Rollback] ${service.name} rolled back and restarted successfully`);

        setTimeout(() => {
          ServiceRegistryService.checkAll().catch(() => {});
        }, 3000);

        res.json({
          success: true,
          service: service.name,
          device: target.id,
          message: "Rolled back to previous image and restarted",
        });
      } else {
        const message =
          tryParseDockerError(restartResult.body) ||
          `Restart after rollback failed: ${restartResult.statusCode}`;
        logger.error(`[Rollback] ${message}`);
        res.status(502).json({ error: message });
      }
    } catch (error: unknown) {
      logger.error(`[Rollback] Failed: ${getErrorMessage(error)}`);
      next(error);
    }
  }, "Services_Rollback")
);

const SIZE_CACHE_TTL_MS = 5 * 60 * 1000;

function createTtlCache<CachedValue>(ttlMs: number): TtlCache<CachedValue> {
  let cache: CachedValue | null = null;
  let cacheAt = 0;
  return {
    get: (now: number) => {
      if (cache && now - cacheAt < ttlMs) return cache;
      return null;
    },
    set: (data: CachedValue, now: number) => {
      cache = data;
      cacheAt = now;
    },
  };
}

const sizeCache = createTtlCache<{
  sizes: Record<string, { sizeKB: number; sizeBytes: number }>;
  fetchedAt: string;
}>(SIZE_CACHE_TTL_MS);

router.get(
  "/sizes",
  asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const now = Date.now();
      const cachedSize = sizeCache.get(now);
      if (cachedSize) {
        return res.json(cachedSize);
      }

      const entries = Object.entries(PROJECTS).filter(([, projectEntry]) => projectEntry.repo);
      const sizes: Record<string, { sizeKB: number; sizeBytes: number }> = {};

      await Promise.allSettled(
        entries.map(async ([id, projectEntry]) => {
          const repoSlug = CodeAnalysisService.extractSlug(projectEntry.repo!);
          if (!repoSlug) return;

          const sizeDetails = await GitHubClient.fetchRepoSize(repoSlug);
          if (sizeDetails) {
            sizes[id] = sizeDetails;
          }
        })
      );

      const response = { sizes, fetchedAt: new Date().toISOString() };
      sizeCache.set(response, now);

      res.json(response);
    } catch (error: unknown) {
      next(error);
    }
  }, "Services_Sizes")
);

router.get(
  "/analysis",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const forceRefresh = req.query.refresh === "true";
      const result = await CodeAnalysisService.analyze(forceRefresh);
      res.json(result);
    } catch (error: unknown) {
      next(error);
    }
  }, "Services_Analysis")
);

const LANG_CACHE_TTL_MS = 15 * 60 * 1000;

interface LanguageBreakdown {
  primary: string | null;
  breakdown: Array<{ language: string; bytes: number; percent: number }>;
  totalBytes: number;
}

const langCache = createTtlCache<{
  languages: Record<string, LanguageBreakdown>;
  fetchedAt: string;
}>(LANG_CACHE_TTL_MS);

router.get(
  "/languages",
  asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const now = Date.now();
      const cached = langCache.get(now);
      if (cached) {
        return res.json(cached);
      }

      const entries = Object.entries(PROJECTS).filter(([, projectEntry]) => projectEntry.repo);
      const languages: Record<string, LanguageBreakdown> = {};

      await Promise.allSettled(
        entries.map(async ([id, projectEntry]) => {
          const repoSlug = CodeAnalysisService.extractSlug(projectEntry.repo!);
          if (!repoSlug) return;

          const languagesMap = await GitHubClient.fetchRepoLanguages(repoSlug);
          if (!languagesMap) return;

          const totalBytes = Object.values(languagesMap).reduce(
            (sum, bytesValue) => sum + bytesValue,
            0
          );

          const sorted = Object.entries(languagesMap).sort(
            ([, firstBytes], [, secondBytes]) => secondBytes - firstBytes
          );
          const primary = sorted.length > 0 ? sorted[0][0] : null;

          languages[id] = {
            primary,
            breakdown: sorted.map(([language, bytes]) => ({
              language,
              bytes,
              percent: totalBytes > 0 ? Math.round((bytes / totalBytes) * 1000) / 10 : 0,
            })),
            totalBytes,
          };
        })
      );

      const response = { languages, fetchedAt: new Date().toISOString() };
      langCache.set(response, now);

      res.json(response);
    } catch (error: unknown) {
      next(error);
    }
  }, "Services_Languages")
);

router.post(
  "/reload",
  asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { vault } = await import("../boot.js");
      vault.clearRegistryCache();
      const registry = await vault.fetchRegistry();

      if (!registry?.projects?.length) {
        return res.status(502).json({ error: "Vault returned empty registry" });
      }

      const previousCount = Object.keys(PROJECTS).length;
      initializeRegistry(registry as unknown as VaultRegistry);
      const newCount = Object.keys(PROJECTS).length;

      ServiceRegistryService.checkAll().catch(() => {});
      InfrastructureRegistryService.checkAll().catch(() => {});

      logger.success(`[Registry] Manual reload — ${previousCount} → ${newCount} projects`);

      res.json({
        success: true,
        previousCount,
        newCount,
        delta: newCount - previousCount,
        message: `Registry reloaded: ${previousCount} → ${newCount} projects`,
      });
    } catch (error: unknown) {
      next(error);
    }
  }, "Services_Reload")
);

function tryParseDockerError(body: string) {
  try {
    return JSON.parse(body).message;
  } catch {
    return null;
  }
}

export default router;
