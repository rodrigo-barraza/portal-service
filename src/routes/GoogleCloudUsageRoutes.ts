// ─── Google Cloud API Usage Routes ───────────────────────────

import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { Router, type Request, type Response } from "express";
import GoogleCloudUsageService from "../services/GoogleCloudUsageService.ts";
import logger from "../utils/logger.ts";

const router = Router();

// ── GET / — Aggregated usage summary ──────────────────────────
// Returns per-API request counts, error rates, and daily sparkline data
// for all tracked Google Cloud APIs that have >0 requests in the period.
//
// Query params:
//   ?period=30d  (default: 30d — supports 7d, 14d, 30d, 90d)

router.get("/", async (request: Request, response: Response) => {
  try {
    const period = String(request.query.period || "30d");
    const allowedPeriods = ["7d", "14d", "30d", "90d"];
    const sanitizedPeriod = allowedPeriods.includes(period) ? period : "30d";

    const summary = await GoogleCloudUsageService.getSummary(sanitizedPeriod);
    response.json(summary);
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    logger.error(`[CloudUsage] Summary failed: ${errorMessage}`);
    response.status(500).json({ error: "Failed to fetch cloud usage summary" });
  }
});

// ── GET /timeseries — Per-service daily time-series ───────────
// Returns daily request counts broken down by success/error for a
// specific Google Cloud API service.
//
// Query params:
//   ?service=places.googleapis.com  (required — service identifier)
//   ?period=30d                     (default: 30d)

router.get("/timeseries", async (request: Request, response: Response) => {
  try {
    const serviceIdentifier = String(request.query.service || "");
    const period = String(request.query.period || "30d");

    if (!serviceIdentifier) {
      response.status(400).json({ error: "Missing required query parameter: service" });
      return;
    }

    // Discovery is dynamic, so any well-formed identifier is queryable —
    // the format check prevents monitoring-filter injection.
    if (!GoogleCloudUsageService.isValidServiceIdentifier(serviceIdentifier)) {
      response.status(400).json({ error: `Invalid service identifier: ${serviceIdentifier}` });
      return;
    }

    const allowedPeriods = ["7d", "14d", "30d", "90d"];
    const sanitizedPeriod = allowedPeriods.includes(period) ? period : "30d";

    const timeSeries = await GoogleCloudUsageService.getTimeSeries(
      serviceIdentifier,
      sanitizedPeriod,
    );
    response.json(timeSeries);
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    logger.error(`[CloudUsage] TimeSeries failed: ${errorMessage}`);
    response.status(500).json({ error: "Failed to fetch cloud usage time series" });
  }
});

export default router;
