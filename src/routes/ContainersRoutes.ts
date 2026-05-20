import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Container Actions Route ────────────────────────────────
// Direct Docker container control by name + device.
// Used for containers that may not have a PROJECTS registry entry.

import { Router, Request, Response, NextFunction } from "express";
import DockerStatsService from "../services/DockerStatsService.ts";
import ServiceRegistryService from "../services/ServiceRegistryService.ts";
import { DEVICES } from "../config.ts";
import logger from "../utils/logger.ts";

const router = Router();

function resolveDevice(deviceId: string) {
  const device = DEVICES[deviceId];
  if (!device || !device.dockerApi) return null;
  return { id: deviceId, device };
}

function tryParseDockerError(body: string) {
  try {
    return JSON.parse(body).message;
  } catch {
    return null;
  }
}

router.post("/:name/restart", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const deviceId = typeof req.query.device === "string" ? req.query.device : undefined;

    if (!deviceId) {
      return res.status(400).json({ error: "Missing required query parameter: device" });
    }

    const target = resolveDevice(deviceId);
    if (!target) {
      return res.status(400).json({ error: `No Docker API configured for device: ${deviceId}` });
    }

    logger.info(`[Container:Restart] ${name} → ${target.id}:/containers/${name}/restart`);

    const result = await DockerStatsService.dockerRequest(
      target.device, "POST", `/containers/${name}/restart?t=10`,
    );

    if (result.statusCode === 204) {
      logger.success(`[Container:Restart] ${name} restarted successfully`);

      setTimeout(() => {
        ServiceRegistryService.checkAll().catch(() => {});
      }, 3000);

      res.json({
        success: true,
        container: name,
        device: target.id,
        message: "Container restarted",
      });
    } else {
      const message = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Container:Restart] Failed for ${name}: ${message}`);
      res.status(502).json({ error: message });
    }
  } catch (error: unknown) {
    logger.error(`[Container:Restart] Failed: ${(error as Error).message}`);
    next(error);
  }
}, "Containers_Restart"));

router.post("/:name/stop", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const deviceId = typeof req.query.device === "string" ? req.query.device : undefined;

    if (!deviceId) {
      return res.status(400).json({ error: "Missing required query parameter: device" });
    }

    const target = resolveDevice(deviceId);
    if (!target) {
      return res.status(400).json({ error: `No Docker API configured for device: ${deviceId}` });
    }

    logger.info(`[Container:Stop] ${name} → ${target.id}:/containers/${name}/stop`);

    const result = await DockerStatsService.dockerRequest(
      target.device, "POST", `/containers/${name}/stop?t=10`,
    );

    if (result.statusCode === 204 || result.statusCode === 304) {
      logger.success(`[Container:Stop] ${name} stopped successfully`);

      setTimeout(() => {
        ServiceRegistryService.checkAll().catch(() => {});
      }, 3000);

      res.json({
        success: true,
        container: name,
        device: target.id,
        message: result.statusCode === 304 ? "Container already stopped" : "Container stopped",
      });
    } else {
      const message = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Container:Stop] Failed for ${name}: ${message}`);
      res.status(502).json({ error: message });
    }
  } catch (error: unknown) {
    logger.error(`[Container:Stop] Failed: ${(error as Error).message}`);
    next(error);
  }
}, "Containers_Stop"));

router.post("/:name/start", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const deviceId = typeof req.query.device === "string" ? req.query.device : undefined;

    if (!deviceId) {
      return res.status(400).json({ error: "Missing required query parameter: device" });
    }

    const target = resolveDevice(deviceId);
    if (!target) {
      return res.status(400).json({ error: `No Docker API configured for device: ${deviceId}` });
    }

    logger.info(`[Container:Start] ${name} → ${target.id}:/containers/${name}/start`);

    const result = await DockerStatsService.dockerRequest(
      target.device, "POST", `/containers/${name}/start`,
    );

    if (result.statusCode === 204 || result.statusCode === 304) {
      logger.success(`[Container:Start] ${name} started successfully`);

      setTimeout(() => {
        ServiceRegistryService.checkAll().catch(() => {});
      }, 3000);

      res.json({
        success: true,
        container: name,
        device: target.id,
        message: result.statusCode === 304 ? "Container already running" : "Container started",
      });
    } else {
      const message = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
      logger.error(`[Container:Start] Failed for ${name}: ${message}`);
      res.status(502).json({ error: message });
    }
  } catch (error: unknown) {
    logger.error(`[Container:Start] Failed: ${(error as Error).message}`);
    next(error);
  }
}, "Containers_Start"));

export default router;
