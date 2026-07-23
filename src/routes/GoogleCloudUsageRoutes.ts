// ─── External API Usage Routes ───────────────────────────────
// Merges every tracked third-party usage source onto one dashboard:
//   • Google Cloud APIs — GCP Cloud Monitoring (GoogleCloudUsageService)
//   • LLM providers     — prism's `requests` collection
//   • Data APIs         — tools-service's `external-api-usage` buckets
// (both via ExternalProviderUsageService)

import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { Router, type Request, type Response } from "express";
import GoogleCloudUsageService, {
  type ApiUsageSummary,
} from "../services/GoogleCloudUsageService.ts";
import ExternalProviderUsageService from "../services/ExternalProviderUsageService.ts";
import logger from "../utils/logger.ts";

const router = Router();

const ALLOWED_PERIODS = ["7d", "14d", "30d", "90d"];

function sanitizePeriod(period: unknown): string {
  const value = String(period || "30d");
  return ALLOWED_PERIODS.includes(value) ? value : "30d";
}

// ── GET / — Aggregated usage summary ──────────────────────────
// Returns per-API request counts, error rates, and daily sparkline data
// for every external API with >0 requests in the period, across all
// usage sources. Any source failing degrades gracefully to the others.
//
// Query params:
//   ?period=30d  (default: 30d — supports 7d, 14d, 30d, 90d)

router.get("/", async (request: Request, response: Response) => {
  try {
    const period = sanitizePeriod(request.query.period);

    const [googleResult, providerResult] = await Promise.allSettled([
      GoogleCloudUsageService.getSummary(period),
      ExternalProviderUsageService.getSummary(period),
    ]);

    if (googleResult.status === "rejected" && providerResult.status === "rejected") {
      throw new Error(
        `all sources failed — google: ${String(googleResult.reason)}; providers: ${String(providerResult.reason)}`,
      );
    }

    const services: ApiUsageSummary[] = [];
    const unreachableSources: string[] = [];

    if (googleResult.status === "fulfilled") {
      services.push(...googleResult.value.services);
    } else {
      unreachableSources.push("google-cloud-monitoring");
      logger.warn(`[CloudUsage] Google source unavailable: ${String(googleResult.reason)}`);
    }

    if (providerResult.status === "fulfilled") {
      services.push(...providerResult.value.services);
      unreachableSources.push(...providerResult.value.unreachableSources);
    } else {
      unreachableSources.push("provider-usage");
      logger.warn(`[CloudUsage] Provider source unavailable: ${String(providerResult.reason)}`);
    }

    services.sort((first, second) => second.totalRequests - first.totalRequests);

    const google = googleResult.status === "fulfilled" ? googleResult.value : null;
    response.json({
      services,
      totalRequests: services.reduce((sum, service) => sum + service.totalRequests, 0),
      totalErrors: services.reduce((sum, service) => sum + service.errorRequests, 0),
      period,
      projectId: google?.projectId ?? "",
      projectIds: google?.projectIds ?? [],
      unreachableProjectIds: google?.unreachableProjectIds ?? [],
      unreachableSources,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    logger.error(`[CloudUsage] Summary failed: ${errorMessage}`);
    response.status(500).json({ error: "Failed to fetch external API usage summary" });
  }
});

// ── GET /timeseries — Per-service daily time-series ───────────
// Returns daily request counts broken down by success/error for one
// external API. The identifier's shape picks the backing source:
//   *.googleapis.com  → GCP Cloud Monitoring
//   llm:<provider>    → prism requests collection
//   anything else     → tools-service usage buckets (hostname)
//
// Query params:
//   ?service=places.googleapis.com  (required — service identifier)
//   ?period=30d                     (default: 30d)

router.get("/timeseries", async (request: Request, response: Response) => {
  try {
    const serviceIdentifier = String(request.query.service || "");
    const period = sanitizePeriod(request.query.period);

    if (!serviceIdentifier) {
      response.status(400).json({ error: "Missing required query parameter: service" });
      return;
    }

    // Discovery is dynamic, so any well-formed identifier is queryable —
    // the format check prevents monitoring-filter injection.
    if (!ExternalProviderUsageService.isValidServiceIdentifier(serviceIdentifier)) {
      response.status(400).json({ error: `Invalid service identifier: ${serviceIdentifier}` });
      return;
    }

    const isGoogleService =
      serviceIdentifier.endsWith(".googleapis.com") &&
      GoogleCloudUsageService.isValidServiceIdentifier(serviceIdentifier);

    const timeSeries = isGoogleService
      ? await GoogleCloudUsageService.getTimeSeries(serviceIdentifier, period)
      : await ExternalProviderUsageService.getTimeSeries(serviceIdentifier, period);

    response.json(timeSeries);
  } catch (error: unknown) {
    const errorMessage = getErrorMessage(error);
    logger.error(`[CloudUsage] TimeSeries failed: ${errorMessage}`);
    response.status(500).json({ error: "Failed to fetch external API usage time series" });
  }
});

export default router;
