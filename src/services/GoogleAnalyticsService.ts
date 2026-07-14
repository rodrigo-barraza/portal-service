import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { BetaAnalyticsDataClient } from "@google-analytics/data";
import logger from "../utils/logger.ts";
import {
  GOOGLE_ANALYTICS_CREDENTIALS,
  ANALYTICS_PROPERTIES,
} from "../config.ts";
import { GoogleAnalyticsDateHelper } from "./google-analytics/GoogleAnalyticsDateHelper.ts";

interface GoogleAnalyticsResponseRow {
  dimensionValues?: { value?: string | null }[] | null;
  metricValues?: { value?: string | null }[] | null;
}

interface GoogleAnalyticsResponse {
  rows?: GoogleAnalyticsResponseRow[] | null;
}

interface TransformedGoogleAnalyticsRow {
  [key: string]: string | number;
}

interface TransformedOverviewMetricPeriod {
  sessions: number;
  pageviews: number;
  activeUsers: number;
  totalUsers: number;
  newUsers: number;
  bounceRate: number;
  avgSessionDuration: number;
  engagedSessions: number;
  engagementRate: number;
}

const cache = new Map<string, { data: unknown; ts: number }>();

function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.data as T);

  const promise = fetcher().then((data) => {
    cache.set(key, { data, ts: Date.now() });
    return data;
  }).catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });

  if (hit) {
    promise.catch(() => {});
    return Promise.resolve(hit.data as T);
  }
  return promise;
}

const REALTIME_TTL = 15_000;
const REPORT_TTL = 60_000;

function getProperties() {
  return ANALYTICS_PROPERTIES;
}

function formatRows(
  response: GoogleAnalyticsResponse | undefined | null,
  dimensionNames: string[],
  metricNames: string[]
): TransformedGoogleAnalyticsRow[] {
  if (!response?.rows) return [];

  return response.rows.map((row: GoogleAnalyticsResponseRow) => {
    const entry: TransformedGoogleAnalyticsRow = {};
    dimensionNames.forEach((name: string, index: number) => {
      entry[name] = row.dimensionValues?.[index]?.value || "";
    });
    metricNames.forEach((name: string, index: number) => {
      const raw = row.metricValues?.[index]?.value || "0";
      entry[name] = name.includes("Rate") || name.includes("Duration")
        ? parseFloat(raw)
        : parseInt(raw, 10);
    });
    return entry;
  });
}

export default class GoogleAnalyticsService {
  public static client: BetaAnalyticsDataClient | null = null;

  public static _getClient() {
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
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      throw new Error(`Failed to initialize GA client: ${errorMessage}`);
    }
  }

  public static listProperties() {
    return getProperties();
  }

  public static async getRealtimeReport(propertyId: string) {
    const key = `realtime:${propertyId}`;
    return cached(key, REALTIME_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runRealtimeReport({
        property: `properties/${propertyId}`,
        dimensions: [{ name: "unifiedScreenName" }],
        metrics: [{ name: "activeUsers" }],
      });

      const pages = formatRows(response, ["pagePath"], ["activeUsers"]);
      const totalActive = pages.reduce((sum: number, page: TransformedGoogleAnalyticsRow) => {
        const users = page.activeUsers;
        return sum + (typeof users === "number" ? users : 0);
      }, 0);

      return {
        activeUsers: totalActive,
        topPages: pages
          .sort((firstRow: TransformedGoogleAnalyticsRow, secondRow: TransformedGoogleAnalyticsRow) => {
            const aUsers = typeof firstRow.activeUsers === "number" ? firstRow.activeUsers : 0;
            const bUsers = typeof secondRow.activeUsers === "number" ? secondRow.activeUsers : 0;
            return bUsers - aUsers;
          })
          .slice(0, 10),
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  public static async getOverviewReport(propertyId: string, period: string = "30d") {
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
          GoogleAnalyticsDateHelper.periodToDateRange(period),
          GoogleAnalyticsDateHelper.previousPeriodRange(period),
        ],
        metrics: metricNames.map((name) => ({ name })),
      });

      const parseRow = (row: GoogleAnalyticsResponseRow | undefined): TransformedOverviewMetricPeriod => {
        const metricValues = row?.metricValues || [];
        return {
          sessions: parseInt(metricValues[0]?.value || "0", 10),
          pageviews: parseInt(metricValues[1]?.value || "0", 10),
          activeUsers: parseInt(metricValues[2]?.value || "0", 10),
          totalUsers: parseInt(metricValues[3]?.value || "0", 10),
          newUsers: parseInt(metricValues[4]?.value || "0", 10),
          bounceRate: parseFloat(metricValues[5]?.value || "0"),
          avgSessionDuration: parseFloat(metricValues[6]?.value || "0"),
          engagedSessions: parseInt(metricValues[7]?.value || "0", 10),
          engagementRate: parseFloat(metricValues[8]?.value || "0"),
        };
      };

      const current = parseRow(response?.rows?.[0]);
      const previous = parseRow(response?.rows?.[1]);

      const delta = (currentValue: number, previousValue: number) => {
        if (!previousValue || previousValue === 0) return currentValue > 0 ? 1 : 0;
        return (currentValue - previousValue) / Math.abs(previousValue);
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

  public static async getTopPages(propertyId: string, period: string = "30d") {
    const key = `pages:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
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

  public static async getTrafficSources(propertyId: string, period: string = "30d") {
    const key = `sources:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
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

  public static async getGeography(propertyId: string, period: string = "30d") {
    const key = `geo:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
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

  public static async getDevices(propertyId: string, period: string = "30d") {
    const key = `devices:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      // Four independent reports — run them in parallel
      const dateRanges = [GoogleAnalyticsDateHelper.periodToDateRange(period)];
      const [[catResponse], [browserResponse], [osResponse], [resResponse]] =
        await Promise.all([
          analyticsClient.runReport({
            property: `properties/${propertyId}`,
            dateRanges,
            dimensions: [{ name: "deviceCategory" }],
            metrics: [
              { name: "activeUsers" },
              { name: "sessions" },
            ],
            orderBys: [
              { metric: { metricName: "sessions" }, desc: true },
            ],
          }),
          analyticsClient.runReport({
            property: `properties/${propertyId}`,
            dateRanges,
            dimensions: [{ name: "browser" }],
            metrics: [
              { name: "activeUsers" },
              { name: "sessions" },
            ],
            orderBys: [
              { metric: { metricName: "sessions" }, desc: true },
            ],
            limit: 10,
          }),
          analyticsClient.runReport({
            property: `properties/${propertyId}`,
            dateRanges,
            dimensions: [{ name: "operatingSystem" }],
            metrics: [
              { name: "activeUsers" },
              { name: "sessions" },
            ],
            orderBys: [
              { metric: { metricName: "sessions" }, desc: true },
            ],
            limit: 10,
          }),
          analyticsClient.runReport({
            property: `properties/${propertyId}`,
            dateRanges,
            dimensions: [{ name: "screenResolution" }],
            metrics: [
              { name: "sessions" },
            ],
            orderBys: [
              { metric: { metricName: "sessions" }, desc: true },
            ],
            limit: 8,
          }),
        ]);

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

  public static async getTimeSeries(propertyId: string, period: string = "30d") {
    const key = `timeseries:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
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

      return {
        series: rows.map((row: TransformedGoogleAnalyticsRow) => ({
          ...row,
          date: String(row.date).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
        })),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  public static async getChannelGrouping(propertyId: string, period: string = "30d") {
    const key = `channels:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
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

  public static async getLandingPages(propertyId: string, period: string = "30d") {
    const key = `landing:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
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

  public static async getHourlyHeatmap(propertyId: string, period: string = "30d") {
    const key = `heatmap:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
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

      return {
        cells: rows.map((row: TransformedGoogleAnalyticsRow) => ({
          ...row,
          hour: parseInt(String(row.hour), 10),
        })),
        period,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  public static async getNewVsReturning(propertyId: string, period: string = "30d") {
    const key = `retention:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
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

  public static async getTopEvents(propertyId: string, period: string = "30d") {
    const key = `events:${propertyId}:${period}`;
    return cached(key, REPORT_TTL, async () => {
      const analyticsClient = GoogleAnalyticsService._getClient();

      const [response] = await analyticsClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [GoogleAnalyticsDateHelper.periodToDateRange(period)],
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
