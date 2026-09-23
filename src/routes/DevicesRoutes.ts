// ─── Devices Route ──────────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { DEVICES, PROJECTS, INFRASTRUCTURE } from "../config.ts";
import type { DeviceSpecs } from "../types.ts";
import ServiceRegistryService from "../services/ServiceRegistryService.ts";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.ts";
import DockerStatsService from "../services/DockerStatsService.ts";

const router = Router();

function extractPort(url: string | null | undefined): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : null;
  } catch {
    return null;
  }
}

router.get("/", async (_req: Request, res: Response) => {
  // Live hardware specs from each device's Docker Engine — cached, and
  // absent (null) for devices without a reachable Docker API.
  let specsByDevice: Record<string, DeviceSpecs> = {};
  try {
    specsByDevice = await DockerStatsService.getDeviceSpecs();
  } catch {
    // Specs are best-effort decoration — the device list must never fail on them.
  }

  const serviceStatusById = new Map(ServiceRegistryService.list().map((status) => [status.id, status]));
  const infraStatusById = new Map(InfrastructureRegistryService.list().map((status) => [status.id, status]));

  const devices = Object.entries(DEVICES).map(([deviceId, device]) => {
    const hostedServices = Object.entries(PROJECTS)
      .filter(([, service]) => service.device === deviceId)
      .map(([serviceId, service]) => {
        const status = serviceStatusById.get(serviceId);
        return {
          id: serviceId,
          name: service.name,
          url: service.url,
          port: extractPort(service.url),
          environment: service.environment,
          visibility: service.visibility,
          dockerProject: service.dockerProject || null,
          deployTier: service.deployTier ?? null,
          healthy: status?.healthy ?? false,
          responseTimeMs: status?.responseTimeMs ?? null,
          error: status?.error ?? null,
          checkedAt: status?.checkedAt ?? null,
        };
      });

    const hostedInfra = Object.entries(INFRASTRUCTURE)
      .filter(([, infra]) => infra.device === deviceId)
      .map(([infraId, infra]) => {
        const status = infraStatusById.get(infraId);
        return {
          id: infraId,
          name: infra.name,
          type: infra.type,
          projectType: infra.projectType || null,
          url: infra.url,
          port: infra.port,
          environment: infra.environment,
          visibility: infra.visibility,
          healthy: status?.healthy ?? false,
          responseTimeMs: status?.responseTimeMs ?? null,
          metadata: status?.metadata ?? null,
          error: status?.error ?? null,
          checkedAt: status?.checkedAt ?? null,
          isInfrastructure: true,
        };
      });

    const hostedCount = hostedServices.length + hostedInfra.length;
    const healthyCount = [...hostedServices, ...hostedInfra].filter((item) => item.healthy).length;

    // Descriptive fields only — the Docker Engine endpoint (an
    // unauthenticated tcp:// socket for remote hosts), docker binary path
    // and SSH alias stay server-side; this API is public.
    return {
      id: deviceId,
      name: device.name,
      type: device.type,
      hostname: device.hostname,
      os: device.os,
      notes: device.notes,
      specs: specsByDevice[deviceId] ?? null,
      services: hostedServices,
      infrastructure: hostedInfra,
      serviceCount: hostedCount,
      healthyCount,
    };
  });

  res.json({ devices });
});

export default router;
