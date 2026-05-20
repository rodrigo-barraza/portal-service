import type { BucketInfo } from "../types.ts";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Stats Route ────────────────────────────────────────────

import { Router, Request, Response, NextFunction } from "express";
import StatsAggregatorService from "../services/StatsAggregatorService.ts";
import DockerStatsService from "../services/DockerStatsService.ts";
import MinioService from "../services/MinioService.ts";
import ContainerMetricsService from "../services/ContainerMetricsService.ts";

const router = Router();

/**
 * GET /stats
 * Returns cached overview stats from Prism.
 */
router.get("/", asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await StatsAggregatorService.getOverview();
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_Overview"));

/**
 * GET /stats/breakdown
 * Returns request breakdown stats. ?period=24h|7d|30d
 */
router.get("/breakdown", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await StatsAggregatorService.getRequestBreakdown({
      period: typeof req.query.period === "string" ? req.query.period : undefined,
    });
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_Breakdown"));

/**
 * GET /stats/projects
 * Returns per-project usage stats.
 */
router.get("/projects", asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await StatsAggregatorService.getProjectStats();
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_Projects"));

/**
 * GET /stats/containers
 * Returns per-container resource usage from Docker Engine APIs.
 * Each container includes a `device` field identifying its host.
 * ?device=synology — filter to a single Docker host.
 */
router.get("/containers", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceId = (typeof req.query.device === "string" ? req.query.device : undefined) || undefined;
    const data = await DockerStatsService.getAll(deviceId);
    res.json({ containers: data, fetchedAt: new Date().toISOString() });
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_Containers"));

/**
 * GET /stats/containers/history
 * Returns time-series ring buffer of container stats.
 * Returns per-device history keyed by device ID.
 * ?device=synology — filter to a single Docker host.
 */
router.get("/containers/history", (req: Request, res: Response) => {
  const deviceId = (typeof req.query.device === "string" ? req.query.device : undefined) || undefined;
  const history = DockerStatsService.getHistory(deviceId);
  // Compute total sample count across all devices
  const samples = Object.values(history).reduce((sum: number, buf: unknown[]) => sum + buf.length, 0);
  res.json({ history, samples });
});

/**
 * GET /stats/containers/metrics
 * Returns persistent container metrics from MongoDB time-series collection.
 * Supports flexible time ranges and per-container/device filtering.
 * ?range=1h|6h|24h|7d — time range (default: 1h)
 * ?container=prism-service — filter to a single container
 * ?device=synology — filter to a single Docker host
 * ?limit=120 — max samples per container (default: 120)
 */
router.get("/containers/metrics", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await ContainerMetricsService.getHistory({
      container: (typeof req.query.container === "string" ? req.query.container : undefined) || undefined,
      device: (typeof req.query.device === "string" ? req.query.device : undefined) || undefined,
      range: typeof req.query.range === "string" ? req.query.range : "1h",
      limit: req.query.limit ? parseInt(typeof req.query.limit === "string" ? req.query.limit : "", 10) : 120,
    });
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_ContainerMetrics"));

/**
 * POST /stats/invalidate
 * Force-clear the stats cache.
 */
router.post("/invalidate", (_req: Request, res: Response) => {
  StatsAggregatorService.invalidate();
  DockerStatsService.invalidate(undefined);
  res.json({ ok: true });
});

/**
 * GET /stats/system
 * Returns Docker host system info and disk usage breakdown.
 * Without ?device=, returns info for all Docker hosts.
 * ?device=synology — filter to a single Docker host.
 */
router.get("/system", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceId = (typeof req.query.device === "string" ? req.query.device : undefined) || undefined;
    const data = await DockerStatsService.getSystemInfo(deviceId);
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_System"));

/**
 * GET /stats/storage
 * Returns MinIO bucket summary — counts and sizes per bucket.
 */
router.get("/storage", asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const buckets = await MinioService.listBuckets();
    const totalObjects = buckets.reduce((sum: number, b: BucketInfo) => sum + b.objectCount, 0);
    const totalSize = buckets.reduce((sum: number, b: BucketInfo) => sum + b.totalSize, 0);
    res.json({ buckets, totalObjects, totalSize, fetchedAt: new Date().toISOString() });
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_Storage"));

export default router;
