// ─── Stats Aggregator Service ───────────────────────────────

import { PROJECTS, STATS_CACHE_TTL_MS } from "../config.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { createApiClient, ApiError, type ApiClient } from "@rodrigo-barraza/utilities-library/http";

interface CacheEntry {
  data: Record<string, unknown>;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

// PROJECTS is hydrated from the registry after boot, so the client is
// cached against whatever base URL is current rather than built at import.
let prismClient: ApiClient | null = null;
let prismClientBaseUrl: string | null = null;

function getPrismClient(baseUrl: string): ApiClient {
  if (!prismClient || prismClientBaseUrl !== baseUrl) {
    prismClient = createApiClient(baseUrl, {
      headers: { Accept: "application/json" },
      timeoutMilliseconds: 5000,
    });
    prismClientBaseUrl = baseUrl;
  }
  return prismClient;
}

export default class StatsAggregatorService {
    static async getOverview() {
    const cached = cache.get("overview");
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    const prismUrl = PROJECTS.prism?.url;
    if (!prismUrl) return { error: "Prism URL not configured" };

    try {
      const [statsRes, healthRes] = await Promise.all([
        StatsAggregatorService._fetch(prismUrl, "/admin/stats/overview"),
        StatsAggregatorService._fetch(prismUrl, "/admin/health"),
      ]);

      const data = {
        stats: statsRes,
        health: healthRes,
        fetchedAt: new Date().toISOString(),
      };

      cache.set("overview", { data, fetchedAt: Date.now() });
      return data;
    } catch (error: unknown) {
      logger.error(`[StatsAggregator] Failed to fetch overview: ${getErrorMessage(error)}`);
      // Return stale cache if available
      if (cached) return { ...cached.data, stale: true };
      return { error: getErrorMessage(error) };
    }
  }

    static async getRequestBreakdown(params: { period?: string } = {}) {
    const cacheKey = `breakdown:${params.period || "24h"}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    const prismUrl = PROJECTS.prism?.url;
    if (!prismUrl) return { error: "Prism URL not configured" };

    try {
      const queryString = new URLSearchParams();
      if (params.period) queryString.set("period", params.period);

      const data = await StatsAggregatorService._fetch(
        prismUrl,
        `/admin/stats/breakdown?${queryString}`,
      );

      cache.set(cacheKey, { data, fetchedAt: Date.now() });
      return data;
    } catch (error: unknown) {
      logger.error(`[StatsAggregator] Breakdown fetch failed: ${getErrorMessage(error)}`);
      if (cached) return { ...cached.data, stale: true };
      return { error: getErrorMessage(error) };
    }
  }

    static async getProjectStats() {
    const cacheKey = "projects";
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    const prismUrl = PROJECTS.prism?.url;
    if (!prismUrl) return { error: "Prism URL not configured" };

    try {
      const data = await StatsAggregatorService._fetch(
        prismUrl,
        "/admin/stats/projects",
      );

      cache.set(cacheKey, { data, fetchedAt: Date.now() });
      return data;
    } catch (error: unknown) {
      logger.error(`[StatsAggregator] Project stats failed: ${getErrorMessage(error)}`);
      if (cached) return { ...cached.data, stale: true };
      return { error: getErrorMessage(error) };
    }
  }

    static async _fetch(baseUrl: string, path: string) {
    try {
      return await getPrismClient(baseUrl).get<Record<string, unknown>>(path);
    } catch (error: unknown) {
      // Preserve the historical "HTTP {status}" failure messages surfaced
      // through getErrorMessage() at the call sites.
      if (error instanceof ApiError) throw new Error(`HTTP ${error.status}`);
      throw error;
    }
  }

    static invalidate() {
    cache.clear();
  }
}
