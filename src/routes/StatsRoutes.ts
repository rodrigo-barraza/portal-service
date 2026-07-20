import type { BucketInfo } from "../types.ts";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Stats Route ────────────────────────────────────────────

import { Router, type Request, type Response, type NextFunction } from "express";
import StatsAggregatorService from "../services/StatsAggregatorService.ts";
import DockerStatsService from "../services/DockerStatsService.ts";
import MinioService from "../services/MinioService.ts";
import ContainerMetricsService from "../services/ContainerMetricsService.ts";

const router = Router();

router.get("/", asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await StatsAggregatorService.getOverview();
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_Overview"));

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

router.get("/projects", asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await StatsAggregatorService.getProjectStats();
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_Projects"));

router.get("/containers", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceId = (typeof req.query.device === "string" ? req.query.device : undefined) || undefined;
    const data = await DockerStatsService.getAll(deviceId);
    res.json({ containers: data, fetchedAt: new Date().toISOString() });
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_Containers"));

router.get("/containers/history", (req: Request, res: Response) => {
  const deviceId = (typeof req.query.device === "string" ? req.query.device : undefined) || undefined;
  const history = DockerStatsService.getHistory(deviceId);
  // Compute total sample count across all devices
  const samples = Object.values(history).reduce((sum: number, buf: unknown[]) => sum + buf.length, 0);
  res.json({ history, samples });
});

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

router.post("/invalidate", (_req: Request, res: Response) => {
  StatsAggregatorService.invalidate();
  DockerStatsService.invalidate(undefined);
  res.json({ ok: true });
});

router.get("/system", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deviceId = (typeof req.query.device === "string" ? req.query.device : undefined) || undefined;
    const data = await DockerStatsService.getSystemInfo(deviceId);
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "Stats_System"));

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
