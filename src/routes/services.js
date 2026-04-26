// ============================================================
// API Portal — Services Route
// ============================================================
// GET /services — returns health status for all Sun services
// and infrastructure backing stores.
// ============================================================

import { Router } from "express";
import ServiceRegistryService from "../services/ServiceRegistryService.js";
import InfrastructureRegistryService from "../services/InfrastructureRegistryService.js";

const router = Router();

/**
 * GET /services
 * Returns the current health status of all registered Sun services
 * plus infrastructure backing stores (MongoDB, MinIO, etc.).
 * If ?refresh=true, forces a fresh health check before responding.
 */
router.get("/", async (req, res, next) => {
  try {
    if (req.query.refresh === "true") {
      const [services, infrastructure] = await Promise.all([
        ServiceRegistryService.checkAll(),
        InfrastructureRegistryService.checkAll(),
      ]);
      return res.json({ services, infrastructure });
    }

    // Return cached status (or "not yet checked" defaults)
    const services = ServiceRegistryService.list();
    const infrastructure = InfrastructureRegistryService.list();
    res.json({ services, infrastructure });
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
    res.json({ services, infrastructure });
  } catch (err) {
    next(err);
  }
});

export default router;

