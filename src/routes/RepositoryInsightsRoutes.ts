// ─── Repository Insights Routes ─────────────────────────────
// GitHub-derived project metadata. Mounted at /services.

import { Router, type Request, type Response } from "express";
import CodeAnalysisService from "../services/CodeAnalysisService.ts";
import RepositoryInsightsService from "../services/RepositoryInsightsService.ts";

const router = Router();

router.get("/sizes", async (_req: Request, res: Response) => {
  res.json(await RepositoryInsightsService.getAllRepoSizes());
});

router.get("/languages", async (_req: Request, res: Response) => {
  res.json(await RepositoryInsightsService.getAllLanguages());
});

router.get("/analysis", async (req: Request, res: Response) => {
  res.json(await CodeAnalysisService.analyze(req.query.refresh === "true"));
});

export default router;
