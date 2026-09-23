import { Router, type Request, type Response } from "express";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { createApiClient } from "@rodrigo-barraza/utilities-library/http";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import { AUTH_HEADERS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { SESSIONS_SERVICE_URL, SESSIONS_STATS_API_SECRET } from "../config.ts";
import logger from "../utils/logger.ts";
import { routeParam, singleValuedQuery } from "../utils/http.ts";

/**
 * SessionAnalyticsRoutes — Proxy layer for sessions-service stats API.
 *
 * Forwards session analytics requests from portal-client through
 * portal-service to sessions-service, attaching the shared stats secret.
 * sessions-service is publicly reachable (api.sessions.rod.dev), so its
 * /stats/* routes reject requests without the secret. Only the fixed
 * paths below are proxied; path parameters are URL-encoded.
 */

const router = Router();

const sessionsClient = SESSIONS_SERVICE_URL
  ? createApiClient(`${SESSIONS_SERVICE_URL}/stats`, {
      headers: {
        ...(SESSIONS_STATS_API_SECRET
          ? { [AUTH_HEADERS.apiSecret]: SESSIONS_STATS_API_SECRET }
          : {}),
      },
      timeoutMilliseconds: 15_000,
    })
  : null;

/**
 * The message of a sessions-service error body, whatever its envelope —
 * it answers `{ error: true, message }` (401/503), `{ error: "…" }`, or a
 * bare `{ message }`.
 */
export function upstreamErrorMessage(body: unknown, status: number): string {
  const candidate = body as { error?: unknown; message?: unknown } | null;
  if (typeof candidate?.error === "string" && candidate.error)
    return candidate.error;
  if (typeof candidate?.message === "string" && candidate.message)
    return candidate.message;
  return `Sessions service error (${status})`;
}

/**
 * Forward a GET to sessions-service. 2xx bodies pass through verbatim;
 * errors keep the upstream status but are re-enveloped as
 * `{ error: "<message>" }` like every other portal error.
 */
async function proxy(
  res: Response,
  sessionsPath: string,
  query: Record<string, string> = {},
) {
  if (!sessionsClient) {
    throw new HttpError("Sessions service URL not configured", 503);
  }

  const queryString = new URLSearchParams(query).toString();
  let response: globalThis.Response;
  try {
    // requestRaw: no throw on non-2xx, so upstream statuses pass through.
    response = await sessionsClient.requestRaw(
      `${sessionsPath}${queryString ? `?${queryString}` : ""}`,
      {
        method: "GET",
      },
    );
  } catch (error: unknown) {
    logger.error(
      `[SessionAnalytics] ${sessionsPath} unreachable: ${getErrorMessage(error)}`,
    );
    throw new HttpError("Sessions service unreachable", 502);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    // Upstream returned non-JSON (e.g. a proxy's HTML error page)
    throw new HttpError(
      `Sessions service returned a non-JSON response (${response.status})`,
      502,
    );
  }

  if (!response.ok) {
    res
      .status(response.status)
      .json({ error: upstreamErrorMessage(data, response.status) });
    return;
  }
  res.status(response.status).json(data);
}

// Straight pass-throughs: GET /session-analytics/<path>?… → sessions /stats/<path>?…
const PASSTHROUGH_PATHS = [
  "/projects",
  "/overview",
  "/sessions",
  "/pages",
  "/referrers",
  "/geo",
  "/devices",
  "/timeseries",
  "/live",
  "/events",
  "/events/feed",
  "/cross-client",
  // Normalized cursor/click/scroll density grid for one page path + viewport band
  "/heatmap",
  "/visitors",
  "/ips",
];

for (const path of PASSTHROUGH_PATHS) {
  router.get(path, (req: Request, res: Response) =>
    proxy(res, path, singleValuedQuery(req)),
  );
}

// ─── GET /session-analytics/session/:sessionId ────────────────

router.get("/session/:sessionId", (req: Request, res: Response) =>
  proxy(res, `/session/${encodeURIComponent(routeParam(req, "sessionId"))}`),
);

// ─── GET /session-analytics/session/:sessionId/replay ─────────
// Full ordered rrweb event stream for one session (playback). The extra path
// segment means it never collides with /session/:sessionId above.

router.get("/session/:sessionId/replay", (req: Request, res: Response) =>
  proxy(
    res,
    `/session/${encodeURIComponent(routeParam(req, "sessionId"))}/replay`,
  ),
);

// ─── GET /session-analytics/ip/:ip ────────────────────────────

router.get("/ip/:ip", (req: Request, res: Response) =>
  proxy(
    res,
    `/ip/${encodeURIComponent(routeParam(req, "ip"))}`,
    singleValuedQuery(req),
  ),
);

export default router;
