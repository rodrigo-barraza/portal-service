// ─── Devices Route ──────────────────────────────────────────

import { Router, Request, Response } from "express";
import { DEVICES, PROJECTS, INFRASTRUCTURE } from "../config.ts";
import ServiceRegistryService from "../services/ServiceRegistryService.ts";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.ts";
import type { ServiceStatus, InfraStatus, ProjectEntry, InfrastructureEntry } from "../types.ts";

const router = Router();

/**
 * GET /devices
 * Returns all known devices with their associated services and health status.
 * Each device includes a list of services it hosts, enriched with live health data.
 * Infrastructure backing stores (MongoDB, MinIO) are included as a separate array.
 */
router.get("/", (_req: Request, res: Response) => {
  // Build service → health lookup from the registry cache
  const serviceStatuses = ServiceRegistryService.list();
  const statusMap = new Map(serviceStatuses.map((s: ServiceStatus) => [s.id, s]));

  // Build infrastructure → health lookup
  const infraStatuses = InfrastructureRegistryService.list();
  const infraMap = new Map(infraStatuses.map((s: InfraStatus) => [s.id, s]));

  // Group services and infrastructure by device
  const devices = Object.entries(DEVICES).map(([deviceId, device]) => {
    // Application services on this device
    const hostedServices = Object.entries(PROJECTS)
      .filter(([, svc]) => (svc as ProjectEntry).device === deviceId)
      .map(([svcId, svc]) => {
        const status = statusMap.get(svcId);
        return {
          id: svcId,
          name: svc.name,
          url: svc.url,
          port: extractPort(svc.url),
          environment: svc.environment,
          visibility: svc.visibility,
          dockerProject: svc.dockerProject || null,
          deployTier: svc.deployTier ?? null,
          healthy: status?.healthy ?? false,
          responseTimeMs: status?.responseTimeMs ?? null,
          error: status?.error ?? null,
          checkedAt: status?.checkedAt ?? null,
        };
      });

    // Infrastructure backing stores on this device
    const hostedInfra = Object.entries(INFRASTRUCTURE)
      .filter(([, infra]) => (infra as InfrastructureEntry).device === deviceId)
      .map(([infraId, infra]) => {
        const status = infraMap.get(infraId);
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

    const allItems = [...hostedServices, ...hostedInfra];
    const healthyCount = allItems.filter((s: { healthy: boolean }) => s.healthy).length;

    return {
      id: deviceId,
      ...device,
      services: hostedServices,
      infrastructure: hostedInfra,
      serviceCount: allItems.length,
      healthyCount,
    };
  });

  res.json({ devices });
});

/**
 * Extract port from a URL string. Returns null if parsing fails.


 */
function extractPort(url: string | null | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : null;
  } catch {
    return null;
  }
}

export default router;

