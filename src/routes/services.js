// ============================================================
// API Portal — Services Route
// ============================================================
// GET /services — returns health status for all Sun services
// and infrastructure backing stores.
// Enriches each item with resolved dependency graph edges.
// ============================================================

import { Router } from "express";
import ServiceRegistryService from "../services/ServiceRegistryService.js";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.js";

const router = Router();

/**
 * Build a lookup map (id → name) and compute the inverse dependency graph.
 * Returns both `dependsOn` (resolved to {id, name}) and `dependedOnBy`.
 */
function enrichWithDependencies(services, infrastructure) {
  const all = [...services, ...infrastructure];

  // id → name lookup
  const nameMap = Object.fromEntries(all.map((s) => [s.id, s.name]));

  // Compute inverse: dependedOnBy[targetId] = [{ id, name }, ...]
  const inverseMap = {};
  for (const item of all) {
    for (const depId of item.dependsOn || []) {
      if (!inverseMap[depId]) inverseMap[depId] = [];
      inverseMap[depId].push({ id: item.id, name: item.name });
    }
  }

  // Enrich each item
  for (const item of all) {
    item.dependsOn = (item.dependsOn || []).map((depId) => ({
      id: depId,
      name: nameMap[depId] || depId,
    }));
    item.dependedOnBy = inverseMap[item.id] || [];
  }

  return { services, infrastructure };
}

/**
 * GET /services
 * Returns the current health status of all registered Sun services
 * plus infrastructure backing stores (MongoDB, MinIO, etc.).
 * If ?refresh=true, forces a fresh health check before responding.
 */
router.get("/", async (req, res, next) => {
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

    res.json(enrichWithDependencies(services, infrastructure));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /services/check
 * Trigger a fresh health check for all services and infrastructure.
 */
router.post("/check", async (_req, res, next) => {
  try {
    const [services, infrastructure] = await Promise.all([
      ServiceRegistryService.checkAll(),
      InfrastructureRegistryService.checkAll(),
    ]);
    res.json(enrichWithDependencies(services, infrastructure));
  } catch (err) {
    next(err);
  }
});

export default router;

