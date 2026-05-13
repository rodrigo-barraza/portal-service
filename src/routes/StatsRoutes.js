import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Stats Route ────────────────────────────────────────────

import { Router } from "express";
import StatsAggregatorService from "../services/StatsAggregatorService.js";
import DockerStatsService from "../services/DockerStatsService.js";
import MinioService from "../services/MinioService.js";

const router = Router();

/**
 * GET /stats
 * Returns cached overview stats from Prism.
 */
router.get("/", asyncHandler(async (_req, res, next) => {
  try {
    const data = await StatsAggregatorService.getOverview();
    res.json(data);
  } catch (err) {
    next(err);
  }
}));

/**
 * GET /stats/breakdown
 * Returns request breakdown stats. ?period=24h|7d|30d
 */
router.get("/breakdown", asyncHandler(async (req, res, next) => {
  try {
    const data = await StatsAggregatorService.getRequestBreakdown({
      period: req.query.period,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
}));

/**
 * GET /stats/projects
 * Returns per-project usage stats.
 */
router.get("/projects", asyncHandler(async (_req, res, next) => {
  try {
    const data = await StatsAggregatorService.getProjectStats();
    res.json(data);
  } catch (err) {
    next(err);
  }
}));

/**
 * GET /stats/containers
 * Returns per-container resource usage from Docker Engine APIs.
 * Each container includes a `device` field identifying its host.
 * ?device=synology — filter to a single Docker host.
 */
router.get("/containers", asyncHandler(async (req, res, next) => {
  try {
    const deviceId = req.query.device || undefined;
    const data = await DockerStatsService.getAll(deviceId);
    res.json({ containers: data, fetchedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
}));

/**
 * GET /stats/containers/history
 * Returns time-series ring buffer of container stats.
 * Returns per-device history keyed by device ID.
 * ?device=synology — filter to a single Docker host.
 */
router.get("/containers/history", (req, res) => {
  const deviceId = req.query.device || undefined;
  const history = DockerStatsService.getHistory(deviceId);
  // Compute total sample count across all devices
  const samples = Object.values(history).reduce((sum, buf) => sum + buf.length, 0);
  res.json({ history, samples });
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
 * Without ?device=, returns info for all Docker hosts.
 * ?device=synology — filter to a single Docker host.
 */
router.get("/system", asyncHandler(async (req, res, next) => {
  try {
    const deviceId = req.query.device || undefined;
    const data = await DockerStatsService.getSystemInfo(deviceId);
    res.json(data);
  } catch (err) {
    next(err);
  }
}));

/**
 * GET /stats/storage
 * Returns MinIO bucket summary — counts and sizes per bucket.
 */
router.get("/storage", asyncHandler(async (_req, res, next) => {
  try {
    const buckets = await MinioService.listBuckets();
    const totalObjects = buckets.reduce((sum, b) => sum + b.objectCount, 0);
    const totalSize = buckets.reduce((sum, b) => sum + b.totalSize, 0);
    res.json({ buckets, totalObjects, totalSize, fetchedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
}));

export default router;
