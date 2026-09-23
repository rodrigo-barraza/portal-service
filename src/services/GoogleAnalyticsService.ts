import { BetaAnalyticsDataClient, protos } from "@google-analytics/data";
import logger from "../utils/logger.ts";
import { GOOGLE_ANALYTICS_CREDENTIALS, ANALYTICS_PROPERTIES } from "../config.ts";
import type { AnalyticsProperty } from "../types.ts";
import { createDedupedTtlCache } from "../utils/cache.ts";
import { parseServiceAccountCredentials } from "../utils/googleCredentials.ts";
import { GoogleAnalyticsDateHelper } from "./google-analytics/GoogleAnalyticsDateHelper.ts";

type AnalyticsResponse = protos.google.analytics.data.v1beta.IRunReportResponse;
type AnalyticsRow = protos.google.analytics.data.v1beta.IRow;
type TransformedRow = Record<string, string | number>;

interface ReportSpec {
  /** GA dimension names, renamed positionally to `dimensionKeys`. */
  dimensions: string[];
  dimensionKeys: string[];
  /** GA metric names, renamed positionally to `metricKeys`. */
  metrics: string[];
  metricKeys: string[];
  /** Sort descending by this GA metric. */
  orderByMetric?: string;
  limit?: number;
}

// Stale-while-revalidate, and concurrent callers for one report share a
// fetch (a dashboard load fires ~11 reports at once, twice with the
// property listing's realtime badges).
const analyticsCache = createDedupedTtlCache({ staleWhileRevalidate: true });

const REALTIME_TTL = 15_000;
const REPORT_TTL = 60_000;
const DEFAULT_PERIOD = "30d";

/** Positional GA values → named keys; *Rate / *Duration metrics stay fractional. */
function formatRows(
  response: AnalyticsResponse | null | undefined,
  dimensionKeys: string[],
  metricKeys: string[],
): TransformedRow[] {
  if (!response?.rows) return [];

  return response.rows.map((row: AnalyticsRow) => {
    const entry: TransformedRow = {};
    dimensionKeys.forEach((key, index) => {
      entry[key] = row.dimensionValues?.[index]?.value || "";
    });
    metricKeys.forEach((key, index) => {
      const raw = row.metricValues?.[index]?.value || "0";
      entry[key] = key.includes("Rate") || key.includes("Duration") ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
    });
    return entry;
  });
}

const OVERVIEW_METRICS = [
  "sessions", "screenPageViews", "activeUsers", "totalUsers",
  "newUsers", "bounceRate", "averageSessionDuration",
  "engagedSessions", "engagementRate",
];

/**
 * The row GA tagged with this `dateRange` name (a multi-range report adds
 * that dimension). Without the header, fall back to request order.
 */
export function findDateRangeRow(
  response: AnalyticsResponse | null | undefined,
  rangeName: string,
  requestIndex: number,
): AnalyticsRow | undefined {
  const dateRangeIndex = response?.dimensionHeaders?.findIndex((header) => header.name === "dateRange") ?? -1;
  if (dateRangeIndex < 0) return response?.rows?.[requestIndex] ?? undefined;
  return response?.rows?.find((row) => row.dimensionValues?.[dateRangeIndex]?.value === rangeName);
}

/** OVERVIEW_METRICS values (in request order) → named numbers; a missing row reads as zeros. */
export function parseOverviewRow(row: AnalyticsRow | undefined) {
  const values = row?.metricValues || [];
  const integer = (index: number) => Number.parseInt(values[index]?.value || "0", 10);
  const decimal = (index: number) => Number.parseFloat(values[index]?.value || "0");
  return {
    sessions: integer(0),
    pageviews: integer(1),
    activeUsers: integer(2),
    totalUsers: integer(3),
    newUsers: integer(4),
    bounceRate: decimal(5),
    avgSessionDuration: decimal(6),
    engagedSessions: integer(7),
    engagementRate: decimal(8),
  };
}

function relativeDelta(currentValue: number, previousValue: number): number {
  if (!previousValue) return currentValue > 0 ? 1 : 0;
  return (currentValue - previousValue) / Math.abs(previousValue);
}

export default class GoogleAnalyticsService {
  public static client: BetaAnalyticsDataClient | null = null;

  public static _getClient(): BetaAnalyticsDataClient {
    if (GoogleAnalyticsService.client) return GoogleAnalyticsService.client;

    const credentials = parseServiceAccountCredentials(GOOGLE_ANALYTICS_CREDENTIALS);
    GoogleAnalyticsService.client = new BetaAnalyticsDataClient({
      credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
      projectId: credentials.project_id,
    });

    logger.success("[GoogleAnalytics] Client initialized");
    return GoogleAnalyticsService.client;
  }

  /** Release the gRPC channel (shutdown). */
  public static async close(): Promise<void> {
    const client = GoogleAnalyticsService.client;
    GoogleAnalyticsService.client = null;
    await client?.close();
  }

  public static listProperties(): AnalyticsProperty[] {
    return ANALYTICS_PROPERTIES;
  }

  /**
   * One report response per (report, property, period), cached with its
   * fetch time — `fetchedAt` says how old the numbers are.
   */
  private static cachedReport<Body extends object>(
    report: string,
    propertyId: string,
    period: string,
    build: () => Promise<Body>,
  ): Promise<Body & { period: string; fetchedAt: string }> {
    return analyticsCache.get(`${report}:${propertyId}:${period}`, REPORT_TTL, async () => ({
      ...(await build()),
      period,
      fetchedAt: new Date().toISOString(),
    }));
  }

  /** A single-date-range report, its rows renamed per `spec`. */
  private static async runReport(propertyId: string, period: string, spec: ReportSpec): Promise<TransformedRow[]> {
    const [response] = await GoogleAnalyticsService._getClient().runReport({
      property: `properties/${propertyId}`,
      dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
      dimensions: spec.dimensions.map((name) => ({ name })),
      metrics: spec.metrics.map((name) => ({ name })),
      ...(spec.orderByMetric ? { orderBys: [{ metric: { metricName: spec.orderByMetric }, desc: true }] } : {}),
      ...(spec.limit ? { limit: spec.limit } : {}),
    });
    return formatRows(response, spec.dimensionKeys, spec.metricKeys);
  }

  public static async getRealtimeReport(propertyId: string) {
    return analyticsCache.get(`realtime:${propertyId}`, REALTIME_TTL, async () => {
      const [response] = await GoogleAnalyticsService._getClient().runRealtimeReport({
        property: `properties/${propertyId}`,
        // Realtime has no pagePath dimension — unifiedScreenName (page
        // title / app screen) is the closest; it is served as `pagePath`.
        dimensions: [{ name: "unifiedScreenName" }],
        metrics: [{ name: "activeUsers" }],
        // GA de-duplicates the TOTAL row; summing per-screen rows counted
        // a visitor once for every screen they touched in the window.
        metricAggregations: [protos.google.analytics.data.v1beta.MetricAggregation.TOTAL],
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
        limit: 10,
      });

      const topPages = formatRows(response, ["pagePath"], ["activeUsers"]);
      const reportedTotal = Number.parseInt(response?.totals?.[0]?.metricValues?.[0]?.value ?? "", 10);
      const activeUsers = Number.isFinite(reportedTotal)
        ? reportedTotal
        : topPages.reduce((sum, page) => sum + Number(page.activeUsers || 0), 0);

      return { activeUsers, topPages, fetchedAt: new Date().toISOString() };
    });
  }

  public static async getOverviewReport(propertyId: string, period: string = DEFAULT_PERIOD) {
    return analyticsCache.get(`overview:${propertyId}:${period}`, REPORT_TTL, async () => {
      const [response] = await GoogleAnalyticsService._getClient().runReport({
        property: `properties/${propertyId}`,
        // Named ranges: GA tags each row with a `dateRange` dimension, row
        // order is unspecified, and a range with no data has no row at all
        // — positional rows[0]/rows[1] could report last period as this one.
        dateRanges: [
          { ...GoogleAnalyticsDateHelper.periodToDateRange(period), name: "current" },
          { ...GoogleAnalyticsDateHelper.previousPeriodRange(period), name: "previous" },
        ],
        metrics: OVERVIEW_METRICS.map((name) => ({ name })),
      });

      const current = parseOverviewRow(findDateRangeRow(response, "current", 0));
      const previous = parseOverviewRow(findDateRangeRow(response, "previous", 1));

      return {
        ...current,
        previous,
        deltas: {
          sessions: relativeDelta(current.sessions, previous.sessions),
          pageviews: relativeDelta(current.pageviews, previous.pageviews),
          totalUsers: relativeDelta(current.totalUsers, previous.totalUsers),
          avgSessionDuration: relativeDelta(current.avgSessionDuration, previous.avgSessionDuration),
          engagementRate: relativeDelta(current.engagementRate, previous.engagementRate),
        },
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  public static getTopPages(propertyId: string, period: string = DEFAULT_PERIOD) {
    return GoogleAnalyticsService.cachedReport("pages", propertyId, period, async () => ({
      pages: await GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["pagePath", "pageTitle"],
        dimensionKeys: ["pagePath", "pageTitle"],
        metrics: ["screenPageViews", "activeUsers", "averageSessionDuration", "bounceRate"],
        metricKeys: ["pageviews", "users", "avgDuration", "bounceRate"],
        orderByMetric: "screenPageViews",
        limit: 20,
      }),
    }));
  }

  public static getTrafficSources(propertyId: string, period: string = DEFAULT_PERIOD) {
    return GoogleAnalyticsService.cachedReport("sources", propertyId, period, async () => ({
      sources: await GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["sessionSource", "sessionMedium"],
        dimensionKeys: ["source", "medium"],
        metrics: ["sessions", "activeUsers", "engagementRate"],
        metricKeys: ["sessions", "users", "engagementRate"],
        orderByMetric: "sessions",
        limit: 15,
      }),
    }));
  }

  public static getGeography(propertyId: string, period: string = DEFAULT_PERIOD) {
    return GoogleAnalyticsService.cachedReport("geo", propertyId, period, async () => ({
      locations: await GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["country", "city"],
        dimensionKeys: ["country", "city"],
        metrics: ["activeUsers", "sessions"],
        metricKeys: ["users", "sessions"],
        orderByMetric: "activeUsers",
        limit: 20,
      }),
    }));
  }

  public static getDevices(propertyId: string, period: string = DEFAULT_PERIOD) {
    return GoogleAnalyticsService.cachedReport("devices", propertyId, period, async () => {
    // Four independent reports — run them in parallel
    const [categories, browsers, operatingSystems, screenResolutions] = await Promise.all([
      GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["deviceCategory"],
        dimensionKeys: ["category"],
        metrics: ["activeUsers", "sessions"],
        metricKeys: ["users", "sessions"],
        orderByMetric: "sessions",
      }),
      GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["browser"],
        dimensionKeys: ["browser"],
        metrics: ["activeUsers", "sessions"],
        metricKeys: ["users", "sessions"],
        orderByMetric: "sessions",
        limit: 10,
      }),
      GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["operatingSystem"],
        dimensionKeys: ["os"],
        metrics: ["activeUsers", "sessions"],
        metricKeys: ["users", "sessions"],
        orderByMetric: "sessions",
        limit: 10,
      }),
      GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["screenResolution"],
        dimensionKeys: ["resolution"],
        metrics: ["sessions"],
        metricKeys: ["sessions"],
        orderByMetric: "sessions",
        limit: 8,
      }),
    ]);

    return { categories, browsers, operatingSystems, screenResolutions };
    });
  }

  public static async getTimeSeries(propertyId: string, period: string = DEFAULT_PERIOD) {
    return analyticsCache.get(`timeseries:${propertyId}:${period}`, REPORT_TTL, async () => {
      const [response] = await GoogleAnalyticsService._getClient().runReport({
        property: `properties/${propertyId}`,
        dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
        dimensions: [{ name: "date" }],
        metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }, { name: "sessions" }],
        orderBys: [{ dimension: { dimensionName: "date" }, desc: false }],
      });

      return {
        series: formatRows(response, ["date"], ["pageviews", "users", "sessions"]).map((row) => ({
          ...row,
          date: String(row.date).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
        })),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  public static getChannelGrouping(propertyId: string, period: string = DEFAULT_PERIOD) {
    return GoogleAnalyticsService.cachedReport("channels", propertyId, period, async () => ({
      channels: await GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["sessionDefaultChannelGroup"],
        dimensionKeys: ["channel"],
        metrics: ["sessions", "totalUsers", "newUsers", "engagementRate"],
        metricKeys: ["sessions", "totalUsers", "newUsers", "engagementRate"],
        orderByMetric: "sessions",
        limit: 12,
      }),
    }));
  }

  public static getLandingPages(propertyId: string, period: string = DEFAULT_PERIOD) {
    return GoogleAnalyticsService.cachedReport("landing", propertyId, period, async () => ({
      pages: await GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["landingPagePlusQueryString"],
        dimensionKeys: ["landingPage"],
        metrics: ["sessions", "totalUsers", "bounceRate", "averageSessionDuration", "engagedSessions"],
        metricKeys: ["sessions", "users", "bounceRate", "avgDuration", "engagedSessions"],
        orderByMetric: "sessions",
        limit: 20,
      }),
    }));
  }

  public static getHourlyHeatmap(propertyId: string, period: string = DEFAULT_PERIOD) {
    return GoogleAnalyticsService.cachedReport("heatmap", propertyId, period, async () => {
      const rows = await GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["dayOfWeekName", "hour"],
        dimensionKeys: ["day", "hour"],
        metrics: ["activeUsers"],
        metricKeys: ["users"],
      });
      return { cells: rows.map((row) => ({ ...row, hour: Number.parseInt(String(row.hour), 10) })) };
    });
  }

  public static getNewVsReturning(propertyId: string, period: string = DEFAULT_PERIOD) {
    return GoogleAnalyticsService.cachedReport("retention", propertyId, period, async () => ({
      segments: await GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["newVsReturning"],
        dimensionKeys: ["segment"],
        metrics: ["totalUsers", "sessions", "engagementRate"],
        metricKeys: ["users", "sessions", "engagementRate"],
        orderByMetric: "totalUsers",
      }),
    }));
  }

  public static getTopEvents(propertyId: string, period: string = DEFAULT_PERIOD) {
    return GoogleAnalyticsService.cachedReport("events", propertyId, period, async () => ({
      events: await GoogleAnalyticsService.runReport(propertyId, period, {
        dimensions: ["eventName"],
        dimensionKeys: ["eventName"],
        metrics: ["eventCount", "totalUsers"],
        metricKeys: ["eventCount", "users"],
        orderByMetric: "eventCount",
        limit: 15,
      }),
    }));
  }
}
