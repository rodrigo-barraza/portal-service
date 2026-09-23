// ─── External API Usage Routes ───────────────────────────────
// Merges every tracked third-party usage source onto one dashboard:
//   • Google Cloud APIs — GCP Cloud Monitoring (GoogleCloudUsageService)
//   • LLM providers     — prism's `requests` collection
//   • Data APIs         — tools-service's `external-api-usage` buckets
// (both via ExternalProviderUsageService)

import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import { Router, type Request, type Response } from "express";
import GoogleCloudUsageService, {
  type ApiUsageSummary,
} from "../services/GoogleCloudUsageService.ts";
import ExternalProviderUsageService from "../services/ExternalProviderUsageService.ts";
import logger from "../utils/logger.ts";
import { queryParam } from "../utils/http.ts";
import { sanitizeUsagePeriod } from "../utils/usagePeriod.ts";

const router = Router();

// ── GET / — Aggregated usage summary ──────────────────────────
// Per-API request counts, error rates, and daily sparkline data for
// every external API with >0 requests in the period, across all usage
// sources. Any source failing degrades gracefully to the others.
//
// Query params:
//   ?period=30d  (default: 30d — supports 7d, 14d, 30d, 90d)

router.get("/", async (req: Request, res: Response) => {
  const period = sanitizeUsagePeriod(req.query.period);

  const [googleResult, providerResult] = await Promise.allSettled([
    GoogleCloudUsageService.getSummary(period),
    ExternalProviderUsageService.getSummary(period),
  ]);

  if (
    googleResult.status === "rejected" &&
    providerResult.status === "rejected"
  ) {
    logger.error(
      `[ExternalApis] All sources failed — google: ${getErrorMessage(googleResult.reason)}; providers: ${getErrorMessage(providerResult.reason)}`,
    );
    throw new HttpError("Failed to fetch external API usage summary", 500);
  }

  const services: ApiUsageSummary[] = [];
  const unreachableSources: string[] = [];

  if (googleResult.status === "fulfilled") {
    services.push(...googleResult.value.services);
  } else {
    unreachableSources.push("google-cloud-monitoring");
    logger.warn(
      `[ExternalApis] Google source unavailable: ${getErrorMessage(googleResult.reason)}`,
    );
  }

  if (providerResult.status === "fulfilled") {
    services.push(...providerResult.value.services);
    unreachableSources.push(...providerResult.value.unreachableSources);
  } else {
    unreachableSources.push("provider-usage");
    logger.warn(
      `[ExternalApis] Provider source unavailable: ${getErrorMessage(providerResult.reason)}`,
    );
  }

  services.sort((first, second) => second.totalRequests - first.totalRequests);

  const google =
    googleResult.status === "fulfilled" ? googleResult.value : null;
  res.json({
    services,
    totalRequests: services.reduce(
      (sum, service) => sum + service.totalRequests,
      0,
    ),
    totalErrors: services.reduce(
      (sum, service) => sum + service.errorRequests,
      0,
    ),
    period,
    projectId: google?.projectId ?? "",
    projectIds: google?.projectIds ?? [],
    unreachableProjectIds: google?.unreachableProjectIds ?? [],
    unreachableSources,
    fetchedAt: new Date().toISOString(),
  });
});

// ── GET /timeseries — Per-service daily time-series ───────────
// Daily request counts broken down by success/error for one external
// API. The identifier's shape picks the backing source:
//   *.googleapis.com  → GCP Cloud Monitoring
//   llm:<provider>    → prism requests collection
//   anything else     → tools-service usage buckets (hostname)
//
// Query params:
//   ?service=places.googleapis.com  (required — service identifier)
//   ?period=30d                     (default: 30d)

router.get("/timeseries", async (req: Request, res: Response) => {
  const serviceIdentifier = queryParam(req, "service");
  const period = sanitizeUsagePeriod(req.query.period);

  if (!serviceIdentifier) {
    throw new HttpError("Missing required query parameter: service", 400);
  }

  // Discovery is dynamic, so any well-formed identifier is queryable —
  // the format check prevents monitoring-filter injection.
  if (
    !ExternalProviderUsageService.isValidServiceIdentifier(serviceIdentifier)
  ) {
    throw new HttpError(
      `Invalid service identifier: ${serviceIdentifier}`,
      400,
    );
  }

  const isGoogleService =
    serviceIdentifier.endsWith(".googleapis.com") &&
    GoogleCloudUsageService.isValidServiceIdentifier(serviceIdentifier);

  try {
    res.json(
      isGoogleService
        ? await GoogleCloudUsageService.getTimeSeries(serviceIdentifier, period)
        : await ExternalProviderUsageService.getTimeSeries(
            serviceIdentifier,
            period,
          ),
    );
  } catch (error: unknown) {
    logger.error(
      `[ExternalApis] Time series failed for ${serviceIdentifier}: ${getErrorMessage(error)}`,
    );
    throw new HttpError("Failed to fetch external API usage time series", 500);
  }
});

export default router;
