// ============================================================
// Google Analytics Service
// ============================================================
// Server-side wrapper around the GA4 Data API v1.
// Uses a service account (base64-encoded JSON key in env) so
// no OAuth flow is needed — pure server-to-server auth.
//
// TTL cache prevents hammering the API (default quotas are
// generous but finite). Realtime refreshes every 15s,
// standard reports every 60s.
// ============================================================

import { BetaAnalyticsDataClient } from "@google-analytics/data";
import logger from "../utils/logger.js";
import {
  GOOGLE_ANALYTICS_CREDENTIALS,
  GOOGLE_ANALYTICS_PROPERTIES,
} from "../config.js";

// ── TTL Cache ──────────────────────────────────────────────────

const cache = new Map();

function cached(key, ttlMs, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.data;

  const promise = fetcher().then((data) => {
    cache.set(key, { data, ts: Date.now() });
    return data;
  }).catch((err) => {
    cache.delete(key);
    throw err;
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

let client = null;
let properties = [];

function getClient() {
  if (client) return client;

  if (!GOOGLE_ANALYTICS_CREDENTIALS) {
    throw new Error("GOOGLE_ANALYTICS_CREDENTIALS is not set");
  }

  try {
    const decoded = Buffer.from(GOOGLE_ANALYTICS_CREDENTIALS, "base64").toString("utf-8");
    const credentials = JSON.parse(decoded);

    client = new BetaAnalyticsDataClient({
      credentials: {
        client_email: credentials.client_email,
        private_key: credentials.private_key,
      },
      projectId: credentials.project_id,
    });

    logger.success("[GoogleAnalytics] Client initialized");
    return client;
  } catch (err) {
    throw new Error(`Failed to initialize GA client: ${err.message}`);
  }
}

function getProperties() {
  if (properties.length > 0) return properties;

  if (!GOOGLE_ANALYTICS_PROPERTIES) {
    return [];
  }

  try {
    properties = JSON.parse(GOOGLE_ANALYTICS_PROPERTIES);
    return properties;
  } catch {
    logger.error("[GoogleAnalytics] Failed to parse GOOGLE_ANALYTICS_PROPERTIES");
    return [];
  }
}

// ── Date Range Helpers ─────────────────────────────────────────

function periodToDateRange(period = "30d") {
  const map = {
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
function previousPeriodRange(period = "30d") {
  const days = parseInt(period) || 30;
  return {
    startDate: `${days * 2}daysAgo`,
    endDate: `${days + 1}daysAgo`,
  };
}

// ── Report Helpers ─────────────────────────────────────────────

function formatRows(response, dimensionNames, metricNames) {
  if (!response?.rows) return [];

  return response.rows.map((row) => {
    const entry = {};
    dimensionNames.forEach((name, i) => {
      entry[name] = row.dimensionValues?.[i]?.value || "";
    });
    metricNames.forEach((name, i) => {
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
  /**
   * List configured GA4 properties.
   */
  static listProperties() {
    return getProperties();
  }

  /**
   * Realtime report — current active users + top active pages.
   */
  static async getRealtimeReport(propertyId) {
    const key = `realtime:${propertyId}`;
    return cached(key, REALTIME_TTL, async () => {
      const analyticsClient = getClient();

      const [response] = await analyticsClient.runRealtimeReport({
        property: `properties/${propertyId}`,
        dimensions: [{ name: "unifiedScreenName" }],
        metrics: [{ name: "activeUsers" }],
      });

      const pages = formatRows(response, ["pagePath"], ["activeUsers"]);
      const totalActive = pages.reduce((sum, p) => sum + p.activeUsers, 0);

      return {
        activeUsers: totalActive,
        topPages: pages
          .sort((a, b) => b.activeUsers - a.activeUsers)
          .slice(0, 10),
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * Overview report — key metrics for the given period.
   */
  static async getOverviewReport(propertyId, period = "30d") {
    const key = `overview:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
        metrics: metricNames.map((name) => ({ name })),
      });

      // With two date ranges, GA4 returns rows tagged by dateRange index.
      // Row 0 = current period, Row 1 = previous period.
      const parseRow = (row) => {
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
      const delta = (cur, prev) => {
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
  static async getTopPages(propertyId, period = "30d") {
    const key = `pages:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
  static async getTrafficSources(propertyId, period = "30d") {
    const key = `sources:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
  static async getGeography(propertyId, period = "30d") {
    const key = `geo:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
  static async getDevices(propertyId, period = "30d") {
    const key = `devices:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
  static async getTimeSeries(propertyId, period = "30d") {
    const key = `timeseries:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
        series: rows.map((r) => ({
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
  static async getChannelGrouping(propertyId, period = "30d") {
    const key = `channels:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
  static async getLandingPages(propertyId, period = "30d") {
    const key = `landing:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
  static async getHourlyHeatmap(propertyId, period = "30d") {
    const key = `heatmap:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
        cells: rows.map((r) => ({
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
  static async getNewVsReturning(propertyId, period = "30d") {
    const key = `retention:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
  static async getTopEvents(propertyId, period = "30d") {
    const key = `events:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = getClient();

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
