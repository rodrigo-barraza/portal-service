import { Router, Request, Response, NextFunction } from "express";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { SESSIONS_SERVICE_URL, SESSIONS_STATS_API_SECRET } from "../config.ts";

/**
 * SessionAnalyticsRoutes — Proxy layer for sessions-service stats API.
 *
 * Forwards all session analytics requests from portal-client through
 * portal-service to sessions-service, attaching the shared stats secret.
 * sessions-service is publicly reachable (api.sessions.rod.dev), so its
 * /stats/* routes reject requests without the secret.
 */

const router = Router();

const SESSIONS_STATS_BASE = `${SESSIONS_SERVICE_URL}/stats`;

/**
 * Generic proxy helper — forwards GET requests to sessions-service.
 */
async function proxy(
  sessionsPath: string,
  query: Record<string, string>,
  res: Response,
  next: NextFunction,
) {
  try {
    if (!SESSIONS_SERVICE_URL) {
      return res.status(503).json({
        error: true,
        message: "Sessions service URL not configured",
      });
    }

    const queryString = new URLSearchParams(query).toString();
    const url = `${SESSIONS_STATS_BASE}${sessionsPath}${queryString ? `?${queryString}` : ""}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(SESSIONS_STATS_API_SECRET ? { "x-api-secret": SESSIONS_STATS_API_SECRET } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      // Upstream returned non-JSON (e.g. an HTML error page)
      return res.status(502).json({
        error: true,
        message: `Sessions service returned a non-JSON response (${response.status})`,
      });
    }
    return res.status(response.status).json(data);
  } catch (error: unknown) {
    logger.error(`[SessionAnalytics] Proxy error: ${getErrorMessage(error)}`);
    next(error);
  }
}

// ─── GET /session-analytics/projects ──────────────────────────

router.get("/projects", (req: Request, res: Response, next: NextFunction) => {
  proxy("/projects", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/overview ──────────────────────────

router.get("/overview", (req: Request, res: Response, next: NextFunction) => {
  proxy("/overview", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/sessions ──────────────────────────

router.get("/sessions", (req: Request, res: Response, next: NextFunction) => {
  proxy("/sessions", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/pages ─────────────────────────────

router.get("/pages", (req: Request, res: Response, next: NextFunction) => {
  proxy("/pages", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/referrers ─────────────────────────

router.get("/referrers", (req: Request, res: Response, next: NextFunction) => {
  proxy("/referrers", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/geo ───────────────────────────────

router.get("/geo", (req: Request, res: Response, next: NextFunction) => {
  proxy("/geo", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/devices ───────────────────────────

router.get("/devices", (req: Request, res: Response, next: NextFunction) => {
  proxy("/devices", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/timeseries ────────────────────────

router.get("/timeseries", (req: Request, res: Response, next: NextFunction) => {
  proxy("/timeseries", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/live ──────────────────────────────

router.get("/live", (req: Request, res: Response, next: NextFunction) => {
  proxy("/live", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/events ────────────────────────────

router.get("/events", (req: Request, res: Response, next: NextFunction) => {
  proxy("/events", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/events/feed ───────────────────────

router.get("/events/feed", (req: Request, res: Response, next: NextFunction) => {
  proxy("/events/feed", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/cross-client ──────────────────────

router.get("/cross-client", (req: Request, res: Response, next: NextFunction) => {
  proxy("/cross-client", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/session/:sessionId ────────────────

router.get("/session/:sessionId", (req: Request, res: Response, next: NextFunction) => {
  const sessionId = String(req.params.sessionId);
  proxy(`/session/${encodeURIComponent(sessionId)}`, {}, res, next);
});

// ─── GET /session-analytics/visitors ──────────────────────────

router.get("/visitors", (req: Request, res: Response, next: NextFunction) => {
  proxy("/visitors", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/ips ───────────────────────────────

router.get("/ips", (req: Request, res: Response, next: NextFunction) => {
  proxy("/ips", req.query as Record<string, string>, res, next);
});

// ─── GET /session-analytics/ip/:ip ────────────────────────────

router.get("/ip/:ip", (req: Request, res: Response, next: NextFunction) => {
  const ip = String(req.params.ip);
  proxy(`/ip/${encodeURIComponent(ip)}`, req.query as Record<string, string>, res, next);
});

export default router;
