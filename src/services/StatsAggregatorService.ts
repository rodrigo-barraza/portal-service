// ─── Stats Aggregator Service ───────────────────────────────

import { PROJECTS, STATS_CACHE_TTL_MS } from "../config.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

interface CacheEntry {
  data: Record<string, unknown>;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

export default class StatsAggregatorService {
    static async getOverview() {
    const cached = cache.get("overview");
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    const prismUrl = PROJECTS.prism.url;
    if (!prismUrl) return { error: "Prism URL not configured" };

    try {
      const [statsRes, healthRes] = await Promise.all([
        StatsAggregatorService._fetch(`${prismUrl}/admin/stats/overview`),
        StatsAggregatorService._fetch(`${prismUrl}/admin/health`),
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

    const prismUrl = PROJECTS.prism.url;
    if (!prismUrl) return { error: "Prism URL not configured" };

    try {
      const queryString = new URLSearchParams();
      if (params.period) queryString.set("period", params.period);

      const data = await StatsAggregatorService._fetch(
        `${prismUrl}/admin/stats/breakdown?${queryString}`,
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

    const prismUrl = PROJECTS.prism.url;
    if (!prismUrl) return { error: "Prism URL not configured" };

    try {
      const data = await StatsAggregatorService._fetch(
        `${prismUrl}/admin/stats/projects`,
      );

      cache.set(cacheKey, { data, fetchedAt: Date.now() });
      return data;
    } catch (error: unknown) {
      logger.error(`[StatsAggregator] Project stats failed: ${getErrorMessage(error)}`);
      if (cached) return { ...cached.data, stale: true };
      return { error: getErrorMessage(error) };
    }
  }

    static async _fetch(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return response.json() as Promise<Record<string, unknown>>;
    } catch (error: unknown) {
      clearTimeout(timeout);
      throw error;
    }
  }

    static invalidate() {
    cache.clear();
  }
}
