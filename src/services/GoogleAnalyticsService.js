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

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [periodToDateRange(period)],
        metrics: [
          { name: "sessions" },
          { name: "screenPageViews" },
          { name: "activeUsers" },
          { name: "totalUsers" },
          { name: "newUsers" },
          { name: "bounceRate" },
          { name: "averageSessionDuration" },
          { name: "engagedSessions" },
          { name: "engagementRate" },
        ],
      });

      const row = response?.rows?.[0];
      const metrics = row?.metricValues || [];

      return {
        sessions: parseInt(metrics[0]?.value || "0", 10),
        pageviews: parseInt(metrics[1]?.value || "0", 10),
        activeUsers: parseInt(metrics[2]?.value || "0", 10),
        totalUsers: parseInt(metrics[3]?.value || "0", 10),
        newUsers: parseInt(metrics[4]?.value || "0", 10),
        bounceRate: parseFloat(metrics[5]?.value || "0"),
        avgSessionDuration: parseFloat(metrics[6]?.value || "0"),
        engagedSessions: parseInt(metrics[7]?.value || "0", 10),
        engagementRate: parseFloat(metrics[8]?.value || "0"),
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

      return {
        categories: formatRows(catResponse, ["category"], ["users", "sessions"]),
        browsers: formatRows(browserResponse, ["browser"], ["users", "sessions"]),
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
}
