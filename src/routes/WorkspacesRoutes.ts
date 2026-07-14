// ─── Workspaces Route ───────────────────────────────────────
// Proxies workspace agent status from tools-service to the
// portal-client so browser requests never need to know the
// internal tools-service URL.

import { Router, Request, Response } from "express";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { PROJECTS } from "../config.ts";
import logger from "../utils/logger.ts";
import MinioService from "../services/MinioService.ts";

const router = Router();

const TOOLS_SERVICE_TIMEOUT_MS = 5000;
const AGENT_BUCKET = "artifacts";
const AGENT_OBJECT_KEY = "workspace-service/workspace-agent.mjs";

function resolveToolsServiceUrl(): string | null {
  const toolsEntry = PROJECTS["tools-service"];
  if (!toolsEntry?.url) return null;
  return toolsEntry.url;
}

router.get("/agents", async (_req: Request, res: Response) => {
  const toolsServiceUrl = resolveToolsServiceUrl();

  if (!toolsServiceUrl) {
    return res.status(503).json({
      error: "tools-service not found in registry",
      count: 0,
      agents: [],
    });
  }

  try {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => controller.abort(),
      TOOLS_SERVICE_TIMEOUT_MS,
    );

    const response = await fetch(`${toolsServiceUrl}/agents`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeoutHandle);

    if (!response.ok) {
      return res.status(response.status).json({
        error: `tools-service returned HTTP ${response.status}`,
        count: 0,
        agents: [],
      });
    }

    const agentsPayload = await response.json();
    res.json(agentsPayload);
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    logger.warn(`[Workspaces] Failed to fetch agents: ${errorMessage}`);
    res.status(503).json({
      error: "Unable to reach tools-service",
      count: 0,
      agents: [],
    });
  }
});

router.get("/download/agent", async (_req: Request, res: Response) => {
  try {
    const objectStat = await MinioService.statObject(AGENT_BUCKET, AGENT_OBJECT_KEY);
    const objectStream = await MinioService.getObject(AGENT_BUCKET, AGENT_OBJECT_KEY);

    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"workspace-agent.mjs\"");
    res.setHeader("Content-Length", String(objectStat.size));
    res.setHeader("Cache-Control", "public, max-age=300");

    objectStream.pipe(res);
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    logger.warn(`[Workspaces] Failed to serve agent download: ${errorMessage}`);
    res.status(404).json({ error: "Workspace agent file not available" });
  }
});

export default router;

