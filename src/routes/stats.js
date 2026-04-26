// ============================================================
// API Portal — Stats Route
// ============================================================
// GET /stats — aggregated usage stats from Prism admin API.
// ============================================================

import { Router } from "express";
import StatsAggregatorService from "../services/StatsAggregatorService.js";

const router = Router();

/**
 * GET /stats
 * Returns cached overview stats from Prism.
 */
router.get("/", async (_req, res, next) => {
  try {
    const data = await StatsAggregatorService.getOverview();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /stats/breakdown
 * Returns request breakdown stats. ?period=24h|7d|30d
 */
router.get("/breakdown", async (req, res, next) => {
  try {
    const data = await StatsAggregatorService.getRequestBreakdown({
      period: req.query.period,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /stats/projects
 * Returns per-project usage stats.
 */
router.get("/projects", async (_req, res, next) => {
  try {
    const data = await StatsAggregatorService.getProjectStats();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /stats/invalidate
 * Force-clear the stats cache.
 */
router.post("/invalidate", (_req, res) => {
  StatsAggregatorService.invalidate();
  res.json({ ok: true });
});

export default router;
