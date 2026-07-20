import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Google Analytics Routes ────────────────────────────────

import { Router, type Request, type Response, type NextFunction } from "express";
import GoogleAnalyticsService from "../services/GoogleAnalyticsService.ts";

const router = Router();

// ── Middleware: validate propertyId ────────────────────────────

const PRESET_PERIOD_PATTERN = /^(7d|30d|90d)$/;
const CUSTOM_RANGE_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/;

function validateProperty(req: Request, res: Response, next: NextFunction) {
  const { propertyId } = req.params;
  const properties = GoogleAnalyticsService.listProperties();

  if (!properties.find((p: { id: string }) => p.id === propertyId)) {
    return res.status(404).json({ error: `Unknown property: ${propertyId}` });
  }

  // Reject junk periods — they'd otherwise become permanent cache keys
  const period = req.query.period;
  if (
    period !== undefined &&
    (typeof period !== "string" ||
      (!PRESET_PERIOD_PATTERN.test(period) && !CUSTOM_RANGE_PATTERN.test(period)))
  ) {
    return res.status(400).json({
      error: "Invalid period — use 7d, 30d, 90d, or YYYY-MM-DD_YYYY-MM-DD",
    });
  }

  next();
}

// ── GET /google-analytics/properties ──────────────────────────

router.get("/properties", (_req: Request, res: Response) => {
  const properties = GoogleAnalyticsService.listProperties();
  res.json({ properties });
});

// ── GET /google-analytics/:propertyId/realtime ────────────────

router.get("/:propertyId/realtime", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getRealtimeReport(String(req.params.propertyId));
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_Realtime"));

// ── GET /google-analytics/:propertyId/overview ────────────────

router.get("/:propertyId/overview", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getOverviewReport(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_Overview"));

// ── GET /google-analytics/:propertyId/pages ───────────────────

router.get("/:propertyId/pages", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getTopPages(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_Pages"));

// ── GET /google-analytics/:propertyId/sources ─────────────────

router.get("/:propertyId/sources", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getTrafficSources(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_Sources"));

// ── GET /google-analytics/:propertyId/geography ───────────────

router.get("/:propertyId/geography", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getGeography(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_Geography"));

// ── GET /google-analytics/:propertyId/devices ─────────────────

router.get("/:propertyId/devices", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getDevices(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_Devices"));

// ── GET /google-analytics/:propertyId/timeseries ──────────────

router.get("/:propertyId/timeseries", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getTimeSeries(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_Timeseries"));

// ── GET /google-analytics/:propertyId/channels ────────────────

router.get("/:propertyId/channels", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getChannelGrouping(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_Channels"));

// ── GET /google-analytics/:propertyId/landing-pages ───────────

router.get("/:propertyId/landing-pages", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getLandingPages(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_LandingPages"));

// ── GET /google-analytics/:propertyId/heatmap ─────────────────

router.get("/:propertyId/heatmap", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getHourlyHeatmap(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_Heatmap"));

// ── GET /google-analytics/:propertyId/new-vs-returning ────────

router.get("/:propertyId/new-vs-returning", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getNewVsReturning(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_NewVsReturning"));

// ── GET /google-analytics/:propertyId/events ──────────────────

router.get("/:propertyId/events", validateProperty, asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await GoogleAnalyticsService.getTopEvents(
      String(req.params.propertyId),
      typeof req.query.period === "string" ? req.query.period : undefined,
    );
    res.json(data);
  } catch (error: unknown) {
    next(error);
  }
}, "GoogleAnalytics_Events"));

export default router;
