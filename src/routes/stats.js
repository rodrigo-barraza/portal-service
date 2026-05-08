// ============================================================
// API Portal — Stats Route
// ============================================================
// GET /stats — aggregated usage stats from Prism admin API.
// ============================================================

import { Router } from "express";
import StatsAggregatorService from "../services/StatsAggregatorService.js";
import DockerStatsService from "../services/DockerStatsService.js";
import MinioService from "../services/MinioService.js";

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
 * GET /stats/containers
 * Returns per-container resource usage from the Docker Engine API.
 */
router.get("/containers", async (_req, res, next) => {
  try {
    const data = await DockerStatsService.getAll();
    res.json({ containers: data, fetchedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /stats/containers/history
 * Returns time-series ring buffer of container stats (last 5 minutes, 5s intervals).
 */
router.get("/containers/history", (_req, res) => {
  const history = DockerStatsService.getHistory();
  res.json({ history, samples: history.length });
});

/**
 * POST /stats/invalidate
 * Force-clear the stats cache.
 */
router.post("/invalidate", (_req, res) => {
  StatsAggregatorService.invalidate();
  DockerStatsService.invalidate();
  res.json({ ok: true });
});

/**
 * GET /stats/system
 * Returns Docker host system info and disk usage breakdown.
 */
router.get("/system", async (_req, res, next) => {
  try {
    const data = await DockerStatsService.getSystemInfo();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /stats/storage
 * Returns MinIO bucket summary — counts and sizes per bucket.
 */
router.get("/storage", async (_req, res, next) => {
  try {
    const buckets = await MinioService.listBuckets();
    const totalObjects = buckets.reduce((sum, b) => sum + b.objectCount, 0);
    const totalSize = buckets.reduce((sum, b) => sum + b.totalSize, 0);
    res.json({ buckets, totalObjects, totalSize, fetchedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

export default router;
