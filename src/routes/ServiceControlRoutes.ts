// ─── Service Control Routes ─────────────────────────────────
// Lifecycle actions on a registry project's Docker container:
// restart / stop / start and image rollback. Mounted at /services.

import { Router, type Request, type Response } from "express";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import { PROJECTS } from "../config.ts";
import type { DeviceEntry, ProjectEntry } from "../types.ts";
import ServiceRegistryService from "../services/ServiceRegistryService.ts";
import {
  CONTAINER_ACTIONS,
  resolveDockerDevice,
  runContainerAction,
} from "../services/docker/ContainerActions.ts";
import {
  getPreviousImage,
  rollbackToPreviousImage,
  type PreviousImageInfo,
} from "../services/docker/ContainerRollback.ts";
import logger from "../utils/logger.ts";
import { routeParam } from "../utils/http.ts";

const router = Router();

interface ContainerTarget {
  service: ProjectEntry;
  dockerProject: string;
  deviceId: string;
  device: DeviceEntry;
}

/** The project, its container name, and its Docker host — or a 404/400. */
function resolveContainerTarget(req: Request): ContainerTarget {
  const id = routeParam(req, "id");
  const service = Object.hasOwn(PROJECTS, id) ? PROJECTS[id] : undefined;
  if (!service) {
    throw new HttpError(`Unknown service: ${id}`, 404);
  }
  if (!service.dockerProject) {
    throw new HttpError(`${service.name} is not a containerized service`, 400);
  }

  const target = resolveDockerDevice(service.device);
  if (!target) {
    throw new HttpError(
      `No Docker API configured for device: ${service.device}`,
      400,
    );
  }

  return {
    service,
    dockerProject: service.dockerProject,
    deviceId: target.id,
    device: target.device,
  };
}

for (const action of CONTAINER_ACTIONS) {
  router.post(`/:id/${action}`, async (req: Request, res: Response) => {
    const target = resolveContainerTarget(req);
    const message = await runContainerAction(
      target.device,
      target.dockerProject,
      action,
      target.service.name,
    );
    ServiceRegistryService.scheduleRecheck();
    res.json({
      success: true,
      service: target.service.name,
      device: target.deviceId,
      message,
    });
  });
}

interface RollbackStatus {
  available: boolean;
  reason?: string;
  service?: string;
  device?: string;
  previousImage?: PreviousImageInfo;
}

/** Whether a project's container has a `:previous` image to roll back to. */
async function rollbackStatus(service: ProjectEntry): Promise<RollbackStatus> {
  if (!service.dockerProject) {
    return { available: false, reason: "Not a containerized service" };
  }
  const target = resolveDockerDevice(service.device);
  if (!target) {
    return { available: false, reason: "No Docker API configured" };
  }

  let previousImage;
  try {
    previousImage = await getPreviousImage(
      target.device,
      service.dockerProject,
    );
  } catch (error: unknown) {
    logger.warn(
      `[Rollback] Status check failed for ${service.name}: ${getErrorMessage(error)}`,
    );
    previousImage = null;
  }

  if (!previousImage) {
    return { available: false, reason: "No previous image found" };
  }
  return {
    available: true,
    service: service.name,
    device: target.id,
    previousImage,
  };
}

// Every containerized project at once, keyed by project id — the Containers
// and Projects pages ask for all of them on load, which as one request per
// card was ~44 round trips (each a Docker image inspect).
router.get("/rollback-status", async (_req: Request, res: Response) => {
  const containerized = Object.entries(PROJECTS).filter(
    ([, service]) => service.dockerProject,
  );
  const statuses = await Promise.all(
    containerized.map(([, service]) => rollbackStatus(service)),
  );
  res.json(
    Object.fromEntries(
      containerized.map(([id], index) => [id, statuses[index]]),
    ),
  );
});

router.get("/:id/rollback-status", async (req: Request, res: Response) => {
  const id = routeParam(req, "id");
  const service = Object.hasOwn(PROJECTS, id) ? PROJECTS[id] : undefined;
  if (!service) {
    throw new HttpError(`Unknown service: ${id}`, 404);
  }
  res.json(await rollbackStatus(service));
});

router.post("/:id/rollback", async (req: Request, res: Response) => {
  const target = resolveContainerTarget(req);
  logger.info(
    `[Rollback] ${target.service.name} → swapping :latest and :previous`,
  );

  try {
    await rollbackToPreviousImage(
      target.device,
      target.dockerProject,
      target.dockerProject,
    );
  } catch (error: unknown) {
    logger.error(
      `[Rollback] ${target.service.name} failed: ${getErrorMessage(error)}`,
    );
    throw error;
  }

  logger.success(`[Rollback] ${target.service.name} rolled back and recreated`);
  ServiceRegistryService.scheduleRecheck();
  res.json({
    success: true,
    service: target.service.name,
    device: target.deviceId,
    message: "Rolled back to previous image and recreated container",
  });
});

export default router;
