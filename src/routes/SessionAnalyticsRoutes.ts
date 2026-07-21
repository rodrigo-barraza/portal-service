import { Router, type Request, type Response, type NextFunction } from "express";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { createApiClient } from "@rodrigo-barraza/utilities-library/http";
import { AUTH_HEADERS } from "@rodrigo-barraza/utilities-library/taxonomy";
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

const sessionsClient = createApiClient(SESSIONS_STATS_BASE, {
  headers: {
    "Content-Type": "application/json",
    ...(SESSIONS_STATS_API_SECRET ? { [AUTH_HEADERS.apiSecret]: SESSIONS_STATS_API_SECRET } : {}),
  },
  timeoutMilliseconds: 15_000,
});

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
    const path = `${sessionsPath}${queryString ? `?${queryString}` : ""}`;

    // requestRaw: upstream status and body pass through verbatim (no throw
    // on non-2xx), preserving the proxy's exact response semantics.
    const response = await sessionsClient.requestRaw(path, { method: "GET" });

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

// ─── GET /session-analytics/session/:sessionId/replay ─────────
// Full ordered rrweb event stream for one session (playback). The extra path
// segment means it never collides with /session/:sessionId above.

router.get("/session/:sessionId/replay", (req: Request, res: Response, next: NextFunction) => {
  const sessionId = String(req.params.sessionId);
  proxy(`/session/${encodeURIComponent(sessionId)}/replay`, {}, res, next);
});

// ─── GET /session-analytics/heatmap ───────────────────────────
// Normalized cursor/click/scroll density grid for one page path + viewport band.

router.get("/heatmap", (req: Request, res: Response, next: NextFunction) => {
  proxy("/heatmap", req.query as Record<string, string>, res, next);
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
