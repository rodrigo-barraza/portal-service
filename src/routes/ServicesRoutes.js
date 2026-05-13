import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Services Route ─────────────────────────────────────────

import { Router } from "express";
import ServiceRegistryService from "../services/ServiceRegistryService.js";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.js";
import DockerStatsService from "../services/DockerStatsService.js";
import { PROJECTS, DEVICES, PROJECT_TYPE_COLORS, DEPLOY_TIER_COLORS } from "../config.js";
import logger from "../utils/logger.js";

const router = Router();

/**
 * Resolve the device object for a project's Docker host.
 * Returns the device entry from the registry that has dockerApi configured.
 * @param {object} svc - Project entry from PROJECTS
 * @returns {{ id: string, device: object } | null}
 */
function resolveDockerDevice(svc) {
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
function enrichWithDependencies(services, infrastructure) {
  const all = [...services, ...infrastructure];

  // id → name lookup
  const nameMap = Object.fromEntries(all.map((s) => [s.id, s.name]));

  // Normalize a dependency entry — handles raw string IDs,
  // structured { id, criticality } objects, and already-enriched
  // { id, name, criticality } objects from cached status.
  const rawId = (dep) => (typeof dep === "string" ? dep : dep.id);
  const rawCriticality = (dep) =>
    typeof dep === "string" ? "required" : dep.criticality || "required";

  // Compute inverse: dependedOnBy[targetId] = [{ id, name, criticality }, ...]
  const inverseMap = {};
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
router.get("/", asyncHandler(async (req, res, next) => {
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
  } catch (err) {
    next(err);
  }
}));

/**
 * POST /services/check
 * Trigger a fresh health check for all services and infrastructure.
 */
router.post("/check", asyncHandler(async (_req, res, next) => {
  try {
    const [services, infrastructure] = await Promise.all([
      ServiceRegistryService.checkAll(),
      InfrastructureRegistryService.checkAll(),
    ]);
    const enriched = enrichWithDependencies(services, infrastructure);
    res.json({ ...enriched, projectTypeColors: PROJECT_TYPE_COLORS, deployTierColors: DEPLOY_TIER_COLORS });
  } catch (err) {
    next(err);
  }
}));

/**
 * POST /services/:id/restart
 * Restart a containerized service via Docker Engine API.
 * Routes to the correct Docker host based on the project's device.
 */
router.post("/:id/restart", asyncHandler(async (req, res, next) => {
  try {
    const { id } = req.params;
    const svc = PROJECTS[id];

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
      const msg = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Restart] Failed for ${svc.name}: ${msg}`);
      res.status(502).json({ error: msg });
    }
  } catch (err) {
    logger.error(`[Restart] Failed: ${err.message}`);
    next(err);
  }
}));

/**
 * POST /services/:id/stop
 * Stop a containerized service via Docker Engine API.
 */
router.post("/:id/stop", asyncHandler(async (req, res, next) => {
  try {
    const { id } = req.params;
    const svc = PROJECTS[id];

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
      const msg = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Stop] Failed for ${svc.name}: ${msg}`);
      res.status(502).json({ error: msg });
    }
  } catch (err) {
    logger.error(`[Stop] Failed: ${err.message}`);
    next(err);
  }
}));

/**
 * POST /services/:id/start
 * Start a containerized service via Docker Engine API.
 */
router.post("/:id/start", asyncHandler(async (req, res, next) => {
  try {
    const { id } = req.params;
    const svc = PROJECTS[id];

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
      const msg = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Start] Failed for ${svc.name}: ${msg}`);
      res.status(502).json({ error: msg });
    }
  } catch (err) {
    logger.error(`[Start] Failed: ${err.message}`);
    next(err);
  }
}));

/**
 * GET /services/:id/rollback-status
 * Check whether a :previous image tag exists for a containerized service,
 * indicating that a rollback is available.
 */
router.get("/:id/rollback-status", asyncHandler(async (req, res, next) => {
  try {
    const { id } = req.params;
    const svc = PROJECTS[id];

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
        target.device,
        `/images/${encodeURIComponent(previousTag)}/json`,
      );
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
  } catch (err) {
    next(err);
  }
}));

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
router.post("/:id/rollback", asyncHandler(async (req, res, next) => {
  try {
    const { id } = req.params;
    const svc = PROJECTS[id];

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
      const msg = tryParseDockerError(tagLatest.body) || `Failed to tag :previous as :latest (${tagLatest.statusCode})`;
      logger.error(`[Rollback] ${msg}`);
      return res.status(502).json({ error: msg });
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
      const msg = tryParseDockerError(restartResult.body) || `Restart after rollback failed: ${restartResult.statusCode}`;
      logger.error(`[Rollback] ${msg}`);
      res.status(502).json({ error: msg });
    }
  } catch (err) {
    logger.error(`[Rollback] Failed: ${err.message}`);
    next(err);
  }
}));

/**
 * GET /services/sizes
 * Returns GitHub repository sizes for all projects with a repo field.
 * Results are cached for 5 minutes to avoid GitHub API rate limits.
 */
let sizeCache = null;
let sizeCacheAt = 0;
const SIZE_CACHE_TTL_MS = 5 * 60 * 1000;

router.get("/sizes", asyncHandler(async (_req, res, next) => {
  try {
    const now = Date.now();
    if (sizeCache && now - sizeCacheAt < SIZE_CACHE_TTL_MS) {
      return res.json(sizeCache);
    }

    const entries = Object.entries(PROJECTS).filter(([, svc]) => svc.repo);
    const sizes = {};

    await Promise.allSettled(
      entries.map(async ([id, svc]) => {
        const match = svc.repo.match(/github\.com\/(.+?)(?:\.git)?$/);
        if (!match) return;

        const slug = match[1];
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
          const resp = await fetch(`https://api.github.com/repos/${slug}`, {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "portal-service",
            },
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (!resp.ok) return;

          const data = await resp.json();
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
    sizeCache = response;
    sizeCacheAt = now;

    res.json(response);
  } catch (err) {
    next(err);
  }
}));

/**
 * Try to extract a message from a Docker API error response body.
 */
function tryParseDockerError(body) {
  try {
    return JSON.parse(body).message;
  } catch {
    return null;
  }
}

export default router;
