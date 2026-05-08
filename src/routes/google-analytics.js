// ============================================================
// API — Google Analytics Routes
// ============================================================
// REST endpoints proxying GA4 Data API reports.
// All routes require a propertyId param matching a configured
// property in GOOGLE_ANALYTICS_PROPERTIES.
// ============================================================

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

router.get("/:propertyId/realtime", validateProperty, async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getRealtimeReport(req.params.propertyId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── GET /google-analytics/:propertyId/overview ────────────────

router.get("/:propertyId/overview", validateProperty, async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getOverviewReport(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── GET /google-analytics/:propertyId/pages ───────────────────

router.get("/:propertyId/pages", validateProperty, async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getTopPages(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── GET /google-analytics/:propertyId/sources ─────────────────

router.get("/:propertyId/sources", validateProperty, async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getTrafficSources(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── GET /google-analytics/:propertyId/geography ───────────────

router.get("/:propertyId/geography", validateProperty, async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getGeography(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── GET /google-analytics/:propertyId/devices ─────────────────

router.get("/:propertyId/devices", validateProperty, async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getDevices(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── GET /google-analytics/:propertyId/timeseries ──────────────

router.get("/:propertyId/timeseries", validateProperty, async (req, res, next) => {
  try {
    const data = await GoogleAnalyticsService.getTimeSeries(
      req.params.propertyId,
      req.query.period,
    );
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
