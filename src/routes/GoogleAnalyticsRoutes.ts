// ─── Google Analytics Routes ────────────────────────────────

import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import GoogleAnalyticsService from "../services/GoogleAnalyticsService.ts";
import { isValidAnalyticsPeriod } from "../services/google-analytics/GoogleAnalyticsDateHelper.ts";
import { queryParam, routeParam } from "../utils/http.ts";

const router = Router();

// ── Middleware: validate propertyId + period ───────────────────

function validateProperty(req: Request, _res: Response, next: NextFunction) {
  const propertyId = routeParam(req, "propertyId");
  if (
    !GoogleAnalyticsService.listProperties().some(
      (property) => property.id === propertyId,
    )
  ) {
    throw new HttpError(`Unknown property: ${propertyId}`, 404);
  }

  // Reject junk periods — they'd otherwise become permanent cache keys
  // (and impossible dates reach the GA API as a 500)
  const period = req.query.period;
  if (
    period !== undefined &&
    (typeof period !== "string" || !isValidAnalyticsPeriod(period))
  ) {
    throw new HttpError(
      "Invalid period — use 7d, 30d, 90d, or YYYY-MM-DD_YYYY-MM-DD",
      400,
    );
  }

  next();
}

// ── GET /google-analytics/properties ──────────────────────────

router.get("/properties", (_req: Request, res: Response) => {
  res.json({ properties: GoogleAnalyticsService.listProperties() });
});

// ── GET /google-analytics/:propertyId/realtime ────────────────

router.get(
  "/:propertyId/realtime",
  validateProperty,
  async (req: Request, res: Response) => {
    res.json(
      await GoogleAnalyticsService.getRealtimeReport(
        routeParam(req, "propertyId"),
      ),
    );
  },
);

// ── GET /google-analytics/:propertyId/<report>?period= ────────

const PERIOD_REPORTS: Record<
  string,
  (propertyId: string, period?: string) => Promise<unknown>
> = {
  overview: (propertyId, period) =>
    GoogleAnalyticsService.getOverviewReport(propertyId, period),
  pages: (propertyId, period) =>
    GoogleAnalyticsService.getTopPages(propertyId, period),
  sources: (propertyId, period) =>
    GoogleAnalyticsService.getTrafficSources(propertyId, period),
  geography: (propertyId, period) =>
    GoogleAnalyticsService.getGeography(propertyId, period),
  devices: (propertyId, period) =>
    GoogleAnalyticsService.getDevices(propertyId, period),
  timeseries: (propertyId, period) =>
    GoogleAnalyticsService.getTimeSeries(propertyId, period),
  channels: (propertyId, period) =>
    GoogleAnalyticsService.getChannelGrouping(propertyId, period),
  "landing-pages": (propertyId, period) =>
    GoogleAnalyticsService.getLandingPages(propertyId, period),
  heatmap: (propertyId, period) =>
    GoogleAnalyticsService.getHourlyHeatmap(propertyId, period),
  "new-vs-returning": (propertyId, period) =>
    GoogleAnalyticsService.getNewVsReturning(propertyId, period),
  events: (propertyId, period) =>
    GoogleAnalyticsService.getTopEvents(propertyId, period),
};

for (const [report, runReport] of Object.entries(PERIOD_REPORTS)) {
  router.get(
    `/:propertyId/${report}`,
    validateProperty,
    async (req: Request, res: Response) => {
      res.json(
        await runReport(
          routeParam(req, "propertyId"),
          queryParam(req, "period"),
        ),
      );
    },
  );
}

export default router;
