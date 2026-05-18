// ─── Google Analytics Service ───────────────────────────────

import { BetaAnalyticsDataClient } from "@google-analytics/data";
import logger from "../utils/logger.ts";
import {
  GOOGLE_ANALYTICS_CREDENTIALS,
  ANALYTICS_PROPERTIES,
} from "../config.ts";

// ── TTL Cache ──────────────────────────────────────────────────

const cache = new Map<string, { data: any; ts: number }>();

function cached(key: string, ttlMs: number, fetcher: () => Promise<any>) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;

  const promise = fetcher().then((data: any) => {
    cache.set(key, { data, ts: Date.now() });
    return data;
  }).catch((error: any) => {
    cache.delete(key);
    throw error;
  });

  // Serve stale while revalidating if we have a previous value
  if (hit) {
    promise.catch(() => {}); // swallow — stale is fine
    return hit.data;
  }
  return promise;
}

const REALTIME_TTL = 15_000;
const REPORT_TTL = 60_000;

// ── Client Initialization ──────────────────────────────────────

function getProperties() {
  return ANALYTICS_PROPERTIES;
}

// ── Date Range Helpers ─────────────────────────────────────────

function periodToDateRange(period: any = "30d") {
  const map: Record<string, string> = {
    "7d": "7daysAgo",
    "30d": "30daysAgo",
    "90d": "90daysAgo",
  };
  return {
    startDate: map[period] || "30daysAgo",
    endDate: "today",
  };
}

/**
 * Compute the previous-period date range of equal length for comparison.
 * e.g. "7d" → current is 7daysAgo..today, previous is 14daysAgo..8daysAgo
 */
function previousPeriodRange(period: any = "30d") {
  const days = parseInt(period) || 30;
  return {
    startDate: `${days * 2}daysAgo`,
    endDate: `${days + 1}daysAgo`,
  };
}

// ── Report Helpers ─────────────────────────────────────────────

function formatRows(response: any, dimensionNames: string[], metricNames: string[]) {
  if (!response?.rows) return [];

  return response.rows.map((row: any) => {
    const entry: Record<string, any> = {};
    dimensionNames.forEach((name: any, i: any) => {
      entry[name] = row.dimensionValues?.[i]?.value || "";
    });
    metricNames.forEach((name: any, i: any) => {
      const raw = row.metricValues?.[i]?.value || "0";
      entry[name] = name.includes("Rate") || name.includes("Duration")
        ? parseFloat(raw)
        : parseInt(raw, 10);
    });
    return entry;
  });
}

// ── Public API ─────────────────────────────────────────────────

export default class GoogleAnalyticsService {
  static client: any = null;

  static _getClient() {
    if (GoogleAnalyticsService.client) return GoogleAnalyticsService.client;

    if (!GOOGLE_ANALYTICS_CREDENTIALS) {
      throw new Error("GOOGLE_ANALYTICS_CREDENTIALS is not set");
    }

    try {
      const decoded = Buffer.from(GOOGLE_ANALYTICS_CREDENTIALS, "base64").toString("utf-8");
      const credentials = JSON.parse(decoded);

      GoogleAnalyticsService.client = new BetaAnalyticsDataClient({
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key,
        },
        projectId: credentials.project_id,
      });

      logger.success("[GoogleAnalytics] Client initialized");
      return GoogleAnalyticsService.client;
    } catch (error: any) {
      throw new Error(`Failed to initialize GA client: ${error.message}`);
    }
  }

  /**
   * List configured GA4 properties.
   */
  static listProperties() {
    return getProperties();
  }

  /**
   * Realtime report — current active users + top active pages.
   */
  static async getRealtimeReport(propertyId: string) {
    const key = `realtime:${propertyId}`;
    return cached(key, REALTIME_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runRealtimeReport({
        property: `properties/${propertyId}`,
        dimensions: [{ name: "unifiedScreenName" }],
        metrics: [{ name: "activeUsers" }],
      });

      const pages = formatRows(response, ["pagePath"], ["activeUsers"]);
      const totalActive = pages.reduce((sum: any, p: any) => sum + p.activeUsers, 0);

      return {
        activeUsers: totalActive,
        topPages: pages
          .sort((a: any, b: any) => b.activeUsers - a.activeUsers)
          .slice(0, 10),
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Overview report — key metrics for the given period.
   */
  static async getOverviewReport(propertyId: string, period: any = "30d") {
    const key = `overview:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const metricNames = [
        "sessions", "screenPageViews", "activeUsers", "totalUsers",
        "newUsers", "bounceRate", "averageSessionDuration",
        "engagedSessions", "engagementRate",
      ];

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [
          periodToDateRange(period),
          previousPeriodRange(period),
        ],
        metrics: metricNames.map((name: any) => ({ name })),
      });

      // With two date ranges, GA4 returns rows tagged by dateRange index.
      // Row 0 = current period, Row 1 = previous period.
      const parseRow = (row: any) => {
        const m = row?.metricValues || [];
        return {
          sessions: parseInt(m[0]?.value || "0", 10),
          pageviews: parseInt(m[1]?.value || "0", 10),
          activeUsers: parseInt(m[2]?.value || "0", 10),
          totalUsers: parseInt(m[3]?.value || "0", 10),
          newUsers: parseInt(m[4]?.value || "0", 10),
          bounceRate: parseFloat(m[5]?.value || "0"),
          avgSessionDuration: parseFloat(m[6]?.value || "0"),
          engagedSessions: parseInt(m[7]?.value || "0", 10),
          engagementRate: parseFloat(m[8]?.value || "0"),
        };
      };

      const current = parseRow(response?.rows?.[0]);
      const previous = parseRow(response?.rows?.[1]);

      // Compute deltas as fractional change (e.g. 0.15 = +15%)
      const delta = (cur: number, prev: number) => {
        if (!prev || prev === 0) return cur > 0 ? 1 : 0;
        return (cur - prev) / Math.abs(prev);
      };

      return {
        ...current,
        previous,
        deltas: {
          sessions: delta(current.sessions, previous.sessions),
          pageviews: delta(current.pageviews, previous.pageviews),
          totalUsers: delta(current.totalUsers, previous.totalUsers),
          avgSessionDuration: delta(current.avgSessionDuration, previous.avgSessionDuration),
          engagementRate: delta(current.engagementRate, previous.engagementRate),
        },
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Top pages by pageviews.
   */
  static async getTopPages(propertyId: string, period: any = "30d") {
    const key = `pages:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [
          { name: "pagePath" },
          { name: "pageTitle" },
        ],
        metrics: [
          { name: "screenPageViews" },
          { name: "activeUsers" },
          { name: "averageSessionDuration" },
          { name: "bounceRate" },
        ],
        orderBys: [
          { metric: { metricName: "screenPageViews" }, desc: true },
        ],
        limit: 20,
      });

      return {
        pages: formatRows(
          response,
          ["pagePath", "pageTitle"],
          ["pageviews", "users", "avgDuration", "bounceRate"],
        ),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Traffic sources — session source / medium breakdown.
   */
  static async getTrafficSources(propertyId: string, period: any = "30d") {
    const key = `sources:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [
          { name: "sessionSource" },
          { name: "sessionMedium" },
        ],
        metrics: [
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "engagementRate" },
        ],
        orderBys: [
          { metric: { metricName: "sessions" }, desc: true },
        ],
        limit: 15,
      });

      return {
        sources: formatRows(
          response,
          ["source", "medium"],
          ["sessions", "users", "engagementRate"],
        ),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Geography — country-level breakdown.
   */
  static async getGeography(propertyId: string, period: any = "30d") {
    const key = `geo:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [
          { name: "country" },
          { name: "city" },
        ],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
        ],
        orderBys: [
          { metric: { metricName: "activeUsers" }, desc: true },
        ],
        limit: 20,
      });

      return {
        locations: formatRows(
          response,
          ["country", "city"],
          ["users", "sessions"],
        ),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Devices — category + browser breakdown.
   */
  static async getDevices(propertyId: string, period: any = "30d") {
    const key = `devices:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      // Device categories
      const [catResponse] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [{ name: "deviceCategory" }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
        ],
        orderBys: [
          { metric: { metricName: "sessions" }, desc: true },
        ],
      });

      // Browsers
      const [browserResponse] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [{ name: "browser" }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
        ],
        orderBys: [
          { metric: { metricName: "sessions" }, desc: true },
        ],
        limit: 10,
      });

      // Operating systems
      const [osResponse] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [{ name: "operatingSystem" }],
        metrics: [
          { name: "activeUsers" },
          { name: "sessions" },
        ],
        orderBys: [
          { metric: { metricName: "sessions" }, desc: true },
        ],
        limit: 10,
      });

      // Screen resolutions
      const [resResponse] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [{ name: "screenResolution" }],
        metrics: [
          { name: "sessions" },
        ],
        orderBys: [
          { metric: { metricName: "sessions" }, desc: true },
        ],
        limit: 8,
      });

      return {
        categories: formatRows(catResponse, ["category"], ["users", "sessions"]),
        browsers: formatRows(browserResponse, ["browser"], ["users", "sessions"]),
        operatingSystems: formatRows(osResponse, ["os"], ["users", "sessions"]),
        screenResolutions: formatRows(resResponse, ["resolution"], ["sessions"]),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Time-series — daily pageviews + users for sparkline/chart rendering.
   */
  static async getTimeSeries(propertyId: string, period: any = "30d") {
    const key = `timeseries:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [{ name: "date" }],
        metrics: [
          { name: "screenPageViews" },
          { name: "activeUsers" },
          { name: "sessions" },
        ],
        orderBys: [
          { dimension: { dimensionName: "date" }, desc: false },
        ],
      });

      const rows = formatRows(
        response,
        ["date"],
        ["pageviews", "users", "sessions"],
      );

      // Format date from YYYYMMDD → YYYY-MM-DD
      return {
        series: rows.map((r: any) => ({
          ...r,
          date: r.date.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
        })),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Channel grouping — sessionDefaultChannelGroup breakdown.
   */
  static async getChannelGrouping(propertyId: string, period: any = "30d") {
    const key = `channels:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [{ name: "sessionDefaultChannelGroup" }],
        metrics: [
          { name: "sessions" },
          { name: "totalUsers" },
          { name: "newUsers" },
          { name: "engagementRate" },
        ],
        orderBys: [
          { metric: { metricName: "sessions" }, desc: true },
        ],
        limit: 12,
      });

      return {
        channels: formatRows(
          response,
          ["channel"],
          ["sessions", "totalUsers", "newUsers", "engagementRate"],
        ),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Landing pages — entry-point page performance.
   */
  static async getLandingPages(propertyId: string, period: any = "30d") {
    const key = `landing:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [{ name: "landingPagePlusQueryString" }],
        metrics: [
          { name: "sessions" },
          { name: "totalUsers" },
          { name: "bounceRate" },
          { name: "averageSessionDuration" },
          { name: "engagedSessions" },
        ],
        orderBys: [
          { metric: { metricName: "sessions" }, desc: true },
        ],
        limit: 20,
      });

      return {
        pages: formatRows(
          response,
          ["landingPage"],
          ["sessions", "users", "bounceRate", "avgDuration", "engagedSessions"],
        ),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Hourly heatmap — dayOfWeekName × hour breakdown for traffic heatmap.
   */
  static async getHourlyHeatmap(propertyId: string, period: any = "30d") {
    const key = `heatmap:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [
          { name: "dayOfWeekName" },
          { name: "hour" },
        ],
        metrics: [
          { name: "activeUsers" },
        ],
      });

      const rows = formatRows(
        response,
        ["day", "hour"],
        ["users"],
      );

      // Convert hour from string to int
      return {
        cells: rows.map((r: any) => ({
          ...r,
          hour: parseInt(r.hour, 10),
        })),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * New vs returning users breakdown.
   */
  static async getNewVsReturning(propertyId: string, period: any = "30d") {
    const key = `retention:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [{ name: "newVsReturning" }],
        metrics: [
          { name: "totalUsers" },
          { name: "sessions" },
          { name: "engagementRate" },
        ],
        orderBys: [
          { metric: { metricName: "totalUsers" }, desc: true },
        ],
      });

      return {
        segments: formatRows(
          response,
          ["segment"],
          ["users", "sessions", "engagementRate"],
        ),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Top events — GA4 event name breakdown.
   */
  static async getTopEvents(propertyId: string, period: any = "30d") {
    const key = `events:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        dimensions: [{ name: "eventName" }],
        metrics: [
          { name: "eventCount" },
          { name: "totalUsers" },
        ],
        orderBys: [
          { metric: { metricName: "eventCount" }, desc: true },
        ],
        limit: 15,
      });

      return {
        events: formatRows(
          response,
          ["eventName"],
          ["eventCount", "users"],
        ),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }
}
