import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Google Analytics Routes ────────────────────────────────

import { Router } from "express";
import GoogleAnalyticsService from "../services/GoogleAnalyticsService.js";

const router = Router();

// ── Middleware: validate propertyId ────────────────────────────

function validateProperty(req, res, next) {
  const { propertyId } = req.params;
  const properties = GoogleAnalyticsService.listProperties();

  if (!properties.find((p) => p.id === propertyId)) {
    return res.status(404).json({ error: `Unknown property: ${propertyId}` });
  }

  next();
}

// ── GET /google-analytics/properties ──────────────────────────

router.get("/properties", (_req, res) => {
  const properties = GoogleAnalyticsService.listProperties();
  res.json({ properties });
});

// ── GET /google-analytics/:propertyId/realtime ────────────────

router.get("/:propertyId/realtime", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getRealtimeReport(req.params.propertyId);
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/overview ────────────────

router.get("/:propertyId/overview", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getOverviewReport(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/pages ───────────────────

router.get("/:propertyId/pages", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getTopPages(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/sources ─────────────────

router.get("/:propertyId/sources", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getTrafficSources(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/geography ───────────────

router.get("/:propertyId/geography", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getGeography(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/devices ─────────────────

router.get("/:propertyId/devices", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getDevices(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/timeseries ──────────────

router.get("/:propertyId/timeseries", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getTimeSeries(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/channels ────────────────

router.get("/:propertyId/channels", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getChannelGrouping(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/landing-pages ───────────

router.get("/:propertyId/landing-pages", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getLandingPages(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/heatmap ─────────────────

router.get("/:propertyId/heatmap", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getHourlyHeatmap(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/new-vs-returning ────────

router.get("/:propertyId/new-vs-returning", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getNewVsReturning(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

// ── GET /google-analytics/:propertyId/events ──────────────────

router.get("/:propertyId/events", validateProperty, asyncHandler(async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getTopEvents(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
}));

export default router;
