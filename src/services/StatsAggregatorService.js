// ============================================================
// Portal API — Stats Aggregator Service
// ============================================================
// Fetches and caches aggregate statistics from Prism's admin API.
// Acts as a caching proxy to avoid hammering upstream services.
// ============================================================

import { SERVICES, STATS_CACHE_TTL_MS } from "../config.js";
import logger from "../utils/logger.js";

/**
 * @typedef {object} CacheEntry
 * @property {any} data
 * @property {number} fetchedAt - Unix timestamp ms
 */

/** @type {Map<string, CacheEntry>} */
const cache = new Map();

export default class StatsAggregatorService {
  /**
   * Get aggregate stats from Prism. Results are cached with a TTL.
   * @returns {Promise<object>}
   */
  static async getOverview() {
    const cached = cache.get("overview");
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    const prismUrl = SERVICES.prism.url;
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
    } catch (err) {
      logger.error(`[StatsAggregator] Failed to fetch overview: ${err.message}`);
      // Return stale cache if available
      if (cached) return { ...cached.data, stale: true };
      return { error: err.message };
    }
  }

  /**
   * Get request breakdown stats from Prism admin.
   * @param {object} [params]
   * @param {string} [params.period] - "24h", "7d", "30d"
   * @returns {Promise<object>}
   */
  static async getRequestBreakdown(params = {}) {
    const cacheKey = `breakdown:${params.period || "24h"}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    const prismUrl = SERVICES.prism.url;
    if (!prismUrl) return { error: "Prism URL not configured" };

    try {
      const qs = new URLSearchParams();
      if (params.period) qs.set("period", params.period);

      const data = await StatsAggregatorService._fetch(
        `${prismUrl}/admin/stats/breakdown?${qs}`,
      );

      cache.set(cacheKey, { data, fetchedAt: Date.now() });
      return data;
    } catch (err) {
      logger.error(`[StatsAggregator] Breakdown fetch failed: ${err.message}`);
      if (cached) return { ...cached.data, stale: true };
      return { error: err.message };
    }
  }

  /**
   * Get per-project stats.
   * @returns {Promise<object>}
   */
  static async getProjectStats() {
    const cacheKey = "projects";
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    const prismUrl = SERVICES.prism.url;
    if (!prismUrl) return { error: "Prism URL not configured" };

    try {
      const data = await StatsAggregatorService._fetch(
        `${prismUrl}/admin/stats/projects`,
      );

      cache.set(cacheKey, { data, fetchedAt: Date.now() });
      return data;
    } catch (err) {
      logger.error(`[StatsAggregator] Project stats failed: ${err.message}`);
      if (cached) return { ...cached.data, stale: true };
      return { error: err.message };
    }
  }

  /**
   * Fetch helper with timeout.
   * @param {string} url
   * @returns {Promise<any>}
   */
  static async _fetch(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return res.json();
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /**
   * Invalidate all cached stats.
   */
  static invalidate() {
    cache.clear();
  }
}
