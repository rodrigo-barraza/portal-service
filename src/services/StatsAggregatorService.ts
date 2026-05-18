// ─── Stats Aggregator Service ───────────────────────────────

import { PROJECTS, STATS_CACHE_TTL_MS } from "../config.ts";
import logger from "../utils/logger.ts";

/**
 * @typedef {object} CacheEntry
 * @property {any} data
 * @property {number} fetchedAt - Unix timestamp ms
 */


const cache = new Map();

export default class StatsAggregatorService {
  /**
   * Get aggregate stats from Prism. Results are cached with a TTL.

   */
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
    } catch (error: any) {
      logger.error(`[StatsAggregator] Failed to fetch overview: ${error.message}`);
      // Return stale cache if available
      if (cached) return { ...cached.data, stale: true };
      return { error: error.message };
    }
  }

  /**
   * Get request breakdown stats from Prism admin.


   */
  static async getRequestBreakdown(params: any = {}) {
    const cacheKey = `breakdown:${params.period || "24h"}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    const prismUrl = PROJECTS.prism.url;
    if (!prismUrl) return { error: "Prism URL not configured" };

    try {
      const qs = new URLSearchParams();
      if (params.period) qs.set("period", params.period);

      const data = await StatsAggregatorService._fetch(
        `${prismUrl}/admin/stats/breakdown?${qs}`,
      );

      cache.set(cacheKey, { data, fetchedAt: Date.now() });
      return data;
    } catch (error: any) {
      logger.error(`[StatsAggregator] Breakdown fetch failed: ${error.message}`);
      if (cached) return { ...cached.data, stale: true };
      return { error: error.message };
    }
  }

  /**
   * Get per-project stats.

   */
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
    } catch (error: any) {
      logger.error(`[StatsAggregator] Project stats failed: ${error.message}`);
      if (cached) return { ...cached.data, stale: true };
      return { error: error.message };
    }
  }

  /**
   * Fetch helper with timeout.


   */
  static async _fetch(url: any) {
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

      return response.json();
    } catch (error: any) {
      clearTimeout(timeout);
      throw error;
    }
  }

  /**
   * Invalidate all cached stats.
   */
  static invalidate() {
    cache.clear();
  }
}
