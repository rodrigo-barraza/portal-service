// ─── Google Cloud API Usage Routes ───────────────────────────

import { Router, Request, Response } from "express";
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
    const errorMessage = error instanceof Error ? error.message : String(error);
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

    // Validate against tracked APIs to prevent arbitrary service queries
    const trackedApis = GoogleCloudUsageService.getTrackedApis();
    const isTracked = trackedApis.some(
      (apiDefinition) => apiDefinition.serviceIdentifier === serviceIdentifier,
    );
    if (!isTracked) {
      response.status(400).json({ error: `Unrecognized service: ${serviceIdentifier}` });
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[CloudUsage] TimeSeries failed: ${errorMessage}`);
    response.status(500).json({ error: "Failed to fetch cloud usage time series" });
  }
});

// ── GET /apis — List tracked API definitions ──────────────────
// Returns the static list of all Google Cloud APIs we track,
// regardless of whether they have usage data.

router.get("/apis", (_request: Request, response: Response) => {
  response.json({
    apis: GoogleCloudUsageService.getTrackedApis(),
    count: GoogleCloudUsageService.getTrackedApis().length,
  });
});

export default router;
