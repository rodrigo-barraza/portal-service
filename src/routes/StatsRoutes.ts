// ─── Stats Route ────────────────────────────────────────────
// Docker container stats (live, ring-buffer history, persisted metrics),
// Docker host disk usage, and object-store totals.

import { Router, type Request, type Response } from "express";
import DockerStatsService from "../services/DockerStatsService.ts";
import MinioService from "../services/MinioService.ts";
import ContainerMetricsService from "../services/ContainerMetricsService.ts";
import { queryParam } from "../utils/http.ts";

const router = Router();

router.get("/containers", async (req: Request, res: Response) => {
  const containers = await DockerStatsService.getAll(queryParam(req, "device"));
  res.json({ containers, fetchedAt: new Date().toISOString() });
});

router.get("/containers/history", (req: Request, res: Response) => {
  const history = DockerStatsService.getHistory(queryParam(req, "device"));
  const samples = Object.values(history).reduce(
    (sum, buffer) => sum + buffer.length,
    0,
  );
  res.json({ history, samples });
});

router.get("/containers/metrics", async (req: Request, res: Response) => {
  const limit = queryParam(req, "limit");
  res.json(
    await ContainerMetricsService.getHistory({
      container: queryParam(req, "container"),
      device: queryParam(req, "device"),
      range: queryParam(req, "range") ?? "1h",
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    }),
  );
});

router.post("/invalidate", (_req: Request, res: Response) => {
  DockerStatsService.invalidate();
  res.json({ ok: true });
});

router.get("/system", async (req: Request, res: Response) => {
  res.json(await DockerStatsService.getSystemInfo(queryParam(req, "device")));
});

router.get("/storage", async (_req: Request, res: Response) => {
  const buckets = await MinioService.listBuckets();
  const totalObjects = buckets.reduce(
    (sum, bucket) => sum + bucket.objectCount,
    0,
  );
  const totalSize = buckets.reduce((sum, bucket) => sum + bucket.totalSize, 0);
  res.json({
    buckets,
    totalObjects,
    totalSize,
    fetchedAt: new Date().toISOString(),
  });
});

export default router;
