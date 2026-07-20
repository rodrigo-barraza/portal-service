import { Router, type Request, type Response, type NextFunction } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import ServiceRegistryService from "../services/ServiceRegistryService.ts";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.ts";
import WatchdogService from "../services/WatchdogService.ts";
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
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { DeviceEntry, ProjectEntry, TtlCache, VaultRegistry } from "../types.ts";
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

/**
 * Stop, rename, and replace a container so it runs the given image tag.
 * Docker binds a container to an image ID at creation time, so re-tagging
 * :latest does nothing until the container is recreated from it.
 * On failure the original container is renamed back and restarted.
 */
async function recreateContainerWithImage(
  device: DeviceEntry,
  containerName: string,
  imageTag: string
): Promise<{ success: true } | { success: false; error: string }> {
  // Snapshot the running container's configuration
  let inspect: Record<string, any>;
  try {
    const inspectBody = await DockerStatsService.dockerGet(
      device,
      `/containers/${encodeURIComponent(containerName)}/json`,
      undefined
    );
    inspect = JSON.parse(inspectBody);
  } catch (error: unknown) {
    return { success: false, error: `Failed to inspect container: ${getErrorMessage(error)}` };
  }

  const oldContainerId = String(inspect.Id);
  const holdingName = `${containerName}-rollback-old`;

  // Networks: keep only creation-time fields — runtime fields (assigned IP,
  // endpoint ID, MAC) belong to the old container.
  const endpointsConfig: Record<string, unknown> = {};
  const networks = (inspect.NetworkSettings?.Networks || {}) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [networkName, endpoint] of Object.entries(networks)) {
    endpointsConfig[networkName] = {
      Aliases: endpoint.Aliases || undefined,
      Links: endpoint.Links || undefined,
      IPAMConfig: endpoint.IPAMConfig || undefined,
    };
  }

  const createPayload = {
    ...(inspect.Config || {}),
    Image: imageTag,
    HostConfig: inspect.HostConfig || {},
    NetworkingConfig: { EndpointsConfig: endpointsConfig },
  };

  // Stop the old container (304 = already stopped) and move it aside
  const stopResult = await DockerStatsService.dockerRequest(
    device,
    "POST",
    `/containers/${oldContainerId}/stop?t=10`
  );
  if (stopResult.statusCode !== 204 && stopResult.statusCode !== 304) {
    return {
      success: false,
      error:
        tryParseDockerError(stopResult.body) ||
        `Failed to stop container (${stopResult.statusCode})`,
    };
  }

  const renameResult = await DockerStatsService.dockerRequest(
    device,
    "POST",
    `/containers/${oldContainerId}/rename?name=${encodeURIComponent(holdingName)}`
  );
  if (renameResult.statusCode !== 204) {
    // Old container still owns its name — just restart it
    await DockerStatsService.dockerRequest(
      device,
      "POST",
      `/containers/${oldContainerId}/start`
    ).catch(() => {});
    return {
      success: false,
      error:
        tryParseDockerError(renameResult.body) ||
        `Failed to rename old container (${renameResult.statusCode})`,
    };
  }

  const restoreOldContainer = async () => {
    await DockerStatsService.dockerRequest(
      device,
      "POST",
      `/containers/${oldContainerId}/rename?name=${encodeURIComponent(containerName)}`
    ).catch(() => {});
    await DockerStatsService.dockerRequest(
      device,
      "POST",
      `/containers/${oldContainerId}/start`
    ).catch(() => {});
  };

  // Create and start the replacement from the rolled-back image
  const createResult = await DockerStatsService.dockerRequest(
    device,
    "POST",
    `/containers/create?name=${encodeURIComponent(containerName)}`,
    { body: createPayload }
  );
  if (createResult.statusCode !== 201) {
    await restoreOldContainer();
    return {
      success: false,
      error:
        tryParseDockerError(createResult.body) ||
        `Failed to create replacement container (${createResult.statusCode})`,
    };
  }

  const newContainerId = String(JSON.parse(createResult.body).Id || "");
  const startResult = await DockerStatsService.dockerRequest(
    device,
    "POST",
    `/containers/${newContainerId}/start`
  );
  if (startResult.statusCode !== 204) {
    await DockerStatsService.dockerRequest(
      device,
      "DELETE",
      `/containers/${newContainerId}?force=true`
    ).catch(() => {});
    await restoreOldContainer();
    return {
      success: false,
      error:
        tryParseDockerError(startResult.body) ||
        `Failed to start replacement container (${startResult.statusCode})`,
    };
  }

  // Success — the old container is disposable now
  await DockerStatsService.dockerRequest(
    device,
    "DELETE",
    `/containers/${oldContainerId}?force=true`
  ).catch(() => {});

  return { success: true };
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
      // Fold in watchdog state (push heartbeat age, down-since) so the
      // portal cards can render it next to checkedAt.
      const decorateWithWatchdog = (item: { id?: unknown }, kind: "service" | "infrastructure") => {
        const stateId = kind === "infrastructure" ? `infra:${String(item.id)}` : String(item.id);
        const state = WatchdogService.getState(stateId);
        if (!state) return item;
        return {
          ...item,
          watchdogStatus: state.status,
          lastHeartbeatAt:
            state.lastHeartbeatAtMs !== null
              ? new Date(state.lastHeartbeatAtMs).toISOString()
              : null,
          downSince:
            state.unhealthySinceMs !== null
              ? new Date(state.unhealthySinceMs).toISOString()
              : null,
        };
      };
      res.json({
        ...enriched,
        services: enriched.services.map((item: { id?: unknown }) => decorateWithWatchdog(item, "service")),
        infrastructure: enriched.infrastructure.map((item: { id?: unknown }) => decorateWithWatchdog(item, "infrastructure")),
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

      // Recreate the container — a restart alone reuses the container's
      // original image ID, so the re-tagged :latest would never run.
      logger.info(`[Rollback] Recreating ${service.name} from rolled-back image`);
      const recreateResult = await recreateContainerWithImage(
        target.device,
        service.dockerProject,
        latestTag
      );

      if (recreateResult.success) {
        logger.success(`[Rollback] ${service.name} rolled back and recreated successfully`);

        setTimeout(() => {
          ServiceRegistryService.checkAll().catch(() => {});
        }, 3000);

        res.json({
          success: true,
          service: service.name,
          device: target.id,
          message: "Rolled back to previous image and recreated container",
        });
      } else {
        logger.error(`[Rollback] ${recreateResult.error}`);
        res.status(502).json({ error: recreateResult.error });
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
      const { vault } = await import("../boot.ts");
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
