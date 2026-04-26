// ============================================================
// API Portal — Services Route
// ============================================================
// GET /services — returns health status for all Sun services.
// ============================================================

import { Router } from "express";
import ServiceRegistryService from "../services/ServiceRegistryService.js";

const router = Router();

/**
 * GET /services
 * Returns the current health status of all registered Sun services.
 * If ?refresh=true, forces a fresh health check before responding.
 */
router.get("/", async (req, res, next) => {
  try {
    if (req.query.refresh === "true") {
      const results = await ServiceRegistryService.checkAll();
      return res.json({ services: results });
    }

    // Return cached status (or "not yet checked" defaults)
    const services = ServiceRegistryService.list();
    res.json({ services });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /services/check
 * Trigger a fresh health check for all services.
 */
router.post("/check", async (_req, res, next) => {
  try {
    const results = await ServiceRegistryService.checkAll();
    res.json({ services: results });
  } catch (err) {
    next(err);
  }
});

export default router;
