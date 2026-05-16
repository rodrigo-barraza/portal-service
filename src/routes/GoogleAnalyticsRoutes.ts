import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Google Analytics Routes ────────────────────────────────

import { Router, Request, Response, NextFunction } from "express";
import GoogleAnalyticsService from "../services/GoogleAnalyticsService.js";

const router = Router();

// ── Middleware: validate propertyId ────────────────────────────

function validateProperty(req: Request, res: Response, next: NextFunction) {
  const { propertyId } = req.params;
  const properties = GoogleAnalyticsService.listProperties();

  if (!properties.find((p: any) => p.id === propertyId)) {
    return res.status(404).json({ error: `Unknown property: ${propertyId}` });
  }

  next();
}

// ── GET /google-analytics/properties ──────────────────────────

router.get("/properties", (_req: any, res: any) => {
  const properties = GoogleAnalyticsService.listProperties();
  res.json({ properties });
});

// ── GET /google-analytics/:propertyId/realtime ────────────────

router.get("/:propertyId/realtime", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getRealtimeReport(req.params.propertyId);
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_Realtime"));

// ── GET /google-analytics/:propertyId/overview ────────────────

router.get("/:propertyId/overview", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getOverviewReport(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_Overview"));

// ── GET /google-analytics/:propertyId/pages ───────────────────

router.get("/:propertyId/pages", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getTopPages(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_Pages"));

// ── GET /google-analytics/:propertyId/sources ─────────────────

router.get("/:propertyId/sources", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getTrafficSources(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_Sources"));

// ── GET /google-analytics/:propertyId/geography ───────────────

router.get("/:propertyId/geography", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getGeography(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_Geography"));

// ── GET /google-analytics/:propertyId/devices ─────────────────

router.get("/:propertyId/devices", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getDevices(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_Devices"));

// ── GET /google-analytics/:propertyId/timeseries ──────────────

router.get("/:propertyId/timeseries", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getTimeSeries(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_Timeseries"));

// ── GET /google-analytics/:propertyId/channels ────────────────

router.get("/:propertyId/channels", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getChannelGrouping(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_Channels"));

// ── GET /google-analytics/:propertyId/landing-pages ───────────

router.get("/:propertyId/landing-pages", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getLandingPages(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_LandingPages"));

// ── GET /google-analytics/:propertyId/heatmap ─────────────────

router.get("/:propertyId/heatmap", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getHourlyHeatmap(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_Heatmap"));

// ── GET /google-analytics/:propertyId/new-vs-returning ────────

router.get("/:propertyId/new-vs-returning", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getNewVsReturning(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_NewVsReturning"));

// ── GET /google-analytics/:propertyId/events ──────────────────

router.get("/:propertyId/events", validateProperty, asyncHandler(async (req: any, res: any, next: any) => {
  try {
    const data = await GoogleAnalyticsService.getTopEvents(
      req.params.propertyId,
      req.query.period as string,
    );
    res.json(data);
  } catch (error: any) {
    next(error);
  }
}, "GoogleAnalytics_Events"));

export default router;
