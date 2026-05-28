// ─── Workspaces Route ───────────────────────────────────────
// Proxies workspace agent status from tools-service to the
// portal-client so browser requests never need to know the
// internal tools-service URL.

import { Router, Request, Response } from "express";
import { PROJECTS } from "../config.ts";
import logger from "../utils/logger.ts";

const router = Router();

const TOOLS_SERVICE_TIMEOUT_MS = 5000;

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
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    logger.warn(`[Workspaces] Failed to fetch agents: ${errorMessage}`);
    res.status(503).json({
      error: "Unable to reach tools-service",
      count: 0,
      agents: [],
    });
  }
});

export default router;
