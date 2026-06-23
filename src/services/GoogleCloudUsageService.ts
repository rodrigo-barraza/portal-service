import { MetricServiceClient } from "@google-cloud/monitoring";
import logger from "../utils/logger.ts";
import { GOOGLE_ANALYTICS_CREDENTIALS } from "../config.ts";

// ── Known Google Cloud APIs Used ──────────────────────────────────
// Curated allowlist of GCP APIs consumed by our infrastructure.
// Only these services appear in the dashboard — everything else is filtered out.

interface GoogleCloudApiDefinition {
  serviceIdentifier: string;
  displayName: string;
  category: string;
  consumer: string;
  docsUrl: string;
}

const TRACKED_API_DEFINITIONS: GoogleCloudApiDefinition[] = [
  {
    serviceIdentifier: "places.googleapis.com",
    displayName: "Places API (New)",
    category: "Maps & Location",
    consumer: "tools-service",
    docsUrl: "https://developers.google.com/maps/documentation/places/web-service",
  },
  {
    serviceIdentifier: "geocoding-backend",
    displayName: "Geocoding API",
    category: "Maps & Location",
    consumer: "tools-service",
    docsUrl: "https://developers.google.com/maps/documentation/geocoding",
  },
  {
    serviceIdentifier: "static-maps-backend",
    displayName: "Static Maps API",
    category: "Maps & Location",
    consumer: "tools-service",
    docsUrl: "https://developers.google.com/maps/documentation/maps-static",
  },
  {
    serviceIdentifier: "airquality.googleapis.com",
    displayName: "Air Quality API",
    category: "Environmental",
    consumer: "tools-service",
    docsUrl: "https://developers.google.com/maps/documentation/air-quality",
  },
  {
    serviceIdentifier: "pollen.googleapis.com",
    displayName: "Pollen API",
    category: "Environmental",
    consumer: "tools-service",
    docsUrl: "https://developers.google.com/maps/documentation/pollen",
  },
  {
    serviceIdentifier: "customsearch.googleapis.com",
    displayName: "Custom Search JSON API",
    category: "Search",
    consumer: "tools-service",
    docsUrl: "https://developers.google.com/custom-search/v1",
  },
  {
    serviceIdentifier: "youtube.googleapis.com",
    displayName: "YouTube Data API v3",
    category: "Media",
    consumer: "tools-service",
    docsUrl: "https://developers.google.com/youtube/v3",
  },
  {
    serviceIdentifier: "calendar-json.googleapis.com",
    displayName: "Google Calendar API",
    category: "Productivity",
    consumer: "tools-service",
    docsUrl: "https://developers.google.com/calendar",
  },
  {
    serviceIdentifier: "analyticsdata.googleapis.com",
    displayName: "GA4 Data API",
    category: "Analytics",
    consumer: "portal-service",
    docsUrl: "https://developers.google.com/analytics/devguides/reporting/data/v1",
  },
];

// ── Types ──────────────────────────────────────────────────────────

interface ApiUsageSummary {
  serviceIdentifier: string;
  displayName: string;
  category: string;
  consumer: string;
  docsUrl: string;
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  errorRate: number;
  dailySeries: { date: string; requests: number }[];
}

interface CloudUsageSummaryResponse {
  services: ApiUsageSummary[];
  totalRequests: number;
  totalErrors: number;
  period: string;
  projectId: string;
  fetchedAt: string;
}

interface TimeSeriesDataPoint {
  date: string;
  requests: number;
  successRequests: number;
  errorRequests: number;
}

interface CloudUsageTimeSeriesResponse {
  serviceIdentifier: string;
  displayName: string;
  series: TimeSeriesDataPoint[];
  period: string;
  fetchedAt: string;
}

// ── Cache ──────────────────────────────────────────────────────────

const usageCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL_MILLISECONDS = 5 * 60 * 1000; // 5 minutes

function getCached<T>(cacheKey: string): T | null {
  const entry = usageCache.get(cacheKey);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MILLISECONDS) {
    return entry.data as T;
  }
  return null;
}

function setCache(cacheKey: string, data: unknown): void {
  usageCache.set(cacheKey, { data, timestamp: Date.now() });
}

// ── Period Parsing ─────────────────────────────────────────────────

function periodToDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  if (match) return parseInt(match[1], 10);
  return 30;
}

function periodToInterval(period: string) {
  const days = periodToDays(period);
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);

  return {
    startTime: { seconds: Math.floor(startTime.getTime() / 1000) },
    endTime: { seconds: Math.floor(endTime.getTime() / 1000) },
  };
}

// ── Service ────────────────────────────────────────────────────────

export default class GoogleCloudUsageService {
  private static monitoringClient: MetricServiceClient | null = null;
  private static cachedProjectId: string | null = null;

  private static getClient(): { client: MetricServiceClient; projectId: string } {
    if (GoogleCloudUsageService.monitoringClient && GoogleCloudUsageService.cachedProjectId) {
      return {
        client: GoogleCloudUsageService.monitoringClient,
        projectId: GoogleCloudUsageService.cachedProjectId,
      };
    }

    if (!GOOGLE_ANALYTICS_CREDENTIALS) {
      throw new Error("GOOGLE_ANALYTICS_CREDENTIALS is not configured — cannot query Cloud Monitoring");
    }

    const decoded = Buffer.from(GOOGLE_ANALYTICS_CREDENTIALS, "base64").toString("utf-8");
    const credentials = JSON.parse(decoded);

    GoogleCloudUsageService.monitoringClient = new MetricServiceClient({
      credentials: {
        client_email: credentials.client_email,
        private_key: credentials.private_key,
      },
      projectId: credentials.project_id,
    });

    GoogleCloudUsageService.cachedProjectId = credentials.project_id;
    logger.success("[CloudUsage] Monitoring client initialized");

    return {
      client: GoogleCloudUsageService.monitoringClient,
      projectId: credentials.project_id,
    };
  }

  static getTrackedApis(): GoogleCloudApiDefinition[] {
    return TRACKED_API_DEFINITIONS;
  }

  static async getSummary(period = "30d"): Promise<CloudUsageSummaryResponse> {
    const cacheKey = `cloud-usage:summary:${period}`;
    const cached = getCached<CloudUsageSummaryResponse>(cacheKey);
    if (cached) return cached;

    const { client, projectId } = GoogleCloudUsageService.getClient();
    const interval = periodToInterval(period);
    const projectName = client.projectPath(projectId);

    // Fetch request counts grouped by service and response code class
    const serviceIdentifiers = TRACKED_API_DEFINITIONS.map(
      (definition) => definition.serviceIdentifier,
    );
    const serviceFilter = serviceIdentifiers
      .map((identifier) => `resource.labels.service = "${identifier}"`)
      .join(" OR ");

    const [requestTimeSeries] = await client.listTimeSeries({
      name: projectName,
      filter: `metric.type = "serviceruntime.googleapis.com/api/request_count" AND (${serviceFilter})`,
      interval,
      view: "FULL",
    });

    // Aggregate per-service
    const serviceDataMap = new Map<
      string,
      {
        totalRequests: number;
        successRequests: number;
        errorRequests: number;
        dailyBuckets: Map<string, number>;
      }
    >();

    for (const timeSeries of requestTimeSeries) {
      const serviceLabel = timeSeries.resource?.labels?.service;
      if (!serviceLabel) continue;

      // Only include tracked services
      if (!serviceIdentifiers.includes(serviceLabel)) continue;

      const responseCodeClass = timeSeries.metric?.labels?.response_code_class;
      const isError =
        responseCodeClass === "4xx" || responseCodeClass === "5xx";

      if (!serviceDataMap.has(serviceLabel)) {
        serviceDataMap.set(serviceLabel, {
          totalRequests: 0,
          successRequests: 0,
          errorRequests: 0,
          dailyBuckets: new Map(),
        });
      }

      const serviceData = serviceDataMap.get(serviceLabel)!;

      for (const point of timeSeries.points || []) {
        const requestCount = Number(point.value?.int64Value || 0);
        serviceData.totalRequests += requestCount;

        if (isError) {
          serviceData.errorRequests += requestCount;
        } else {
          serviceData.successRequests += requestCount;
        }

        // Aggregate into daily buckets
        const pointTimestamp = point.interval?.endTime?.seconds;
        if (pointTimestamp) {
          const dateString = new Date(Number(pointTimestamp) * 1000)
            .toISOString()
            .slice(0, 10);
          serviceData.dailyBuckets.set(
            dateString,
            (serviceData.dailyBuckets.get(dateString) || 0) + requestCount,
          );
        }
      }
    }

    // Build response — only include services with actual usage
    const services: ApiUsageSummary[] = [];
    let grandTotalRequests = 0;
    let grandTotalErrors = 0;

    for (const definition of TRACKED_API_DEFINITIONS) {
      const serviceData = serviceDataMap.get(definition.serviceIdentifier);
      if (!serviceData || serviceData.totalRequests === 0) continue;

      const dailySeries = Array.from(serviceData.dailyBuckets.entries())
        .map(([date, requests]) => ({ date, requests }))
        .sort((first, second) => first.date.localeCompare(second.date));

      services.push({
        serviceIdentifier: definition.serviceIdentifier,
        displayName: definition.displayName,
        category: definition.category,
        consumer: definition.consumer,
        docsUrl: definition.docsUrl,
        totalRequests: serviceData.totalRequests,
        successRequests: serviceData.successRequests,
        errorRequests: serviceData.errorRequests,
        errorRate:
          serviceData.totalRequests > 0
            ? serviceData.errorRequests / serviceData.totalRequests
            : 0,
        dailySeries,
      });

      grandTotalRequests += serviceData.totalRequests;
      grandTotalErrors += serviceData.errorRequests;
    }

    // Sort by total requests descending
    services.sort((first, second) => second.totalRequests - first.totalRequests);

    const result: CloudUsageSummaryResponse = {
      services,
      totalRequests: grandTotalRequests,
      totalErrors: grandTotalErrors,
      period,
      projectId,
      fetchedAt: new Date().toISOString(),
    };

    setCache(cacheKey, result);
    return result;
  }

  static async getTimeSeries(
    serviceIdentifier: string,
    period = "30d",
  ): Promise<CloudUsageTimeSeriesResponse> {
    const cacheKey = `cloud-usage:timeseries:${serviceIdentifier}:${period}`;
    const cached = getCached<CloudUsageTimeSeriesResponse>(cacheKey);
    if (cached) return cached;

    const definition = TRACKED_API_DEFINITIONS.find(
      (apiDefinition) => apiDefinition.serviceIdentifier === serviceIdentifier,
    );
    if (!definition) {
      throw new Error(`Unknown service identifier: ${serviceIdentifier}`);
    }

    const { client, projectId } = GoogleCloudUsageService.getClient();
    const interval = periodToInterval(period);
    const projectName = client.projectPath(projectId);

    const [requestTimeSeries] = await client.listTimeSeries({
      name: projectName,
      filter: `metric.type = "serviceruntime.googleapis.com/api/request_count" AND resource.labels.service = "${serviceIdentifier}"`,
      interval,
      view: "FULL",
    });

    // Aggregate into daily buckets by response code class
    const dailyBuckets = new Map<
      string,
      { requests: number; successRequests: number; errorRequests: number }
    >();

    for (const timeSeries of requestTimeSeries) {
      const responseCodeClass = timeSeries.metric?.labels?.response_code_class;
      const isError =
        responseCodeClass === "4xx" || responseCodeClass === "5xx";

      for (const point of timeSeries.points || []) {
        const requestCount = Number(point.value?.int64Value || 0);
        const pointTimestamp = point.interval?.endTime?.seconds;
        if (!pointTimestamp) continue;

        const dateString = new Date(Number(pointTimestamp) * 1000)
          .toISOString()
          .slice(0, 10);

        if (!dailyBuckets.has(dateString)) {
          dailyBuckets.set(dateString, {
            requests: 0,
            successRequests: 0,
            errorRequests: 0,
          });
        }

        const bucket = dailyBuckets.get(dateString)!;
        bucket.requests += requestCount;

        if (isError) {
          bucket.errorRequests += requestCount;
        } else {
          bucket.successRequests += requestCount;
        }
      }
    }

    const series: TimeSeriesDataPoint[] = Array.from(dailyBuckets.entries())
      .map(([date, values]) => ({ date, ...values }))
      .sort((first, second) => first.date.localeCompare(second.date));

    const result: CloudUsageTimeSeriesResponse = {
      serviceIdentifier,
      displayName: definition.displayName,
      series,
      period,
      fetchedAt: new Date().toISOString(),
    };

    setCache(cacheKey, result);
    return result;
  }
}
