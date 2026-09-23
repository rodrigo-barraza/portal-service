// ─── Container Actions Route ────────────────────────────────
// Direct Docker container control by name + device, for containers that
// may not have a PROJECTS registry entry; plus cached site previews.

import { Router, type Request, type Response } from "express";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import ServiceRegistryService from "../services/ServiceRegistryService.ts";
import ScreenshotService from "../services/ScreenshotService.ts";
import {
  CONTAINER_ACTIONS,
  VALID_CONTAINER_NAME_PATTERN,
  resolveDockerDevice,
  runContainerAction,
} from "../services/docker/ContainerActions.ts";
import { queryParam, routeParam } from "../utils/http.ts";

const router = Router();

// Hostnames only — no ports, paths, or userinfo sneaking into the URL
// ScreenshotService navigates to.
const VALID_DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// Cached site thumbnail for a registered client domain — the static
// preview shown on the /containers card view instead of a live iframe.
router.get("/previews/:domain", async (req: Request, res: Response) => {
  const domain = routeParam(req, "domain");

  if (!VALID_DOMAIN_PATTERN.test(domain)) {
    throw new HttpError("Invalid domain", 400);
  }
  if (!ScreenshotService.isAllowedDomain(domain)) {
    throw new HttpError(`Unknown domain: ${domain}`, 404);
  }

  const screenshot = await ScreenshotService.getScreenshot(domain);

  res
    .type(screenshot.contentType)
    .setHeader("Cache-Control", "public, max-age=300")
    .setHeader("X-Captured-At", new Date(screenshot.capturedAt).toISOString())
    .send(screenshot.buffer);
});

for (const action of CONTAINER_ACTIONS) {
  router.post(`/:name/${action}`, async (req: Request, res: Response) => {
    const name = routeParam(req, "name");
    const deviceId = queryParam(req, "device");

    if (!VALID_CONTAINER_NAME_PATTERN.test(name)) {
      throw new HttpError("Invalid container name", 400);
    }
    if (!deviceId) {
      throw new HttpError("Missing required query parameter: device", 400);
    }

    const target = resolveDockerDevice(deviceId);
    if (!target) {
      throw new HttpError(
        `No Docker API configured for device: ${deviceId}`,
        400,
      );
    }

    const message = await runContainerAction(
      target.device,
      name,
      action,
      `${target.id}/${name}`,
    );
    ServiceRegistryService.scheduleRecheck();
    res.json({ success: true, container: name, device: target.id, message });
  });
}

export default router;
