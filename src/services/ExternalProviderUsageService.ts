// ─── Non-Google External Provider Usage ────────────────────────────
// Complements GoogleCloudUsageService (GCP Cloud Monitoring) with the
// rest of the fleet's third-party API traffic, read straight from Mongo:
//
//   1. LLM / inference providers — prism-service's `requests` collection
//      (one document per generation, already the cost source of truth).
//      Google is skipped here because Cloud Monitoring already reports
//      generativelanguage.googleapis.com; local providers (ollama, vllm…)
//      are skipped because they aren't external.
//   2. Data-API fetchers — tools-service's `external-api-usage` collection
//      (daily per-host buckets written by its global-fetch instrumentation;
//      see tools-service/src/services/ExternalApiUsageService.ts).
//
// Both sources are mapped onto the same ApiUsageSummary shape the
// dashboard already renders, so cards merge seamlessly with the GCP ones.
// ─────────────────────────────────────────────────────────────────────

import { createTtlCache } from "@rodrigo-barraza/utilities-library/cache";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  isLocalProvider,
  resolveProviderBaseType,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import logger from "../utils/logger.ts";
import { PRISM_MONGO_DB_NAME, TOOLS_MONGO_DB_NAME } from "../config.ts";
import type {
  ApiUsageSummary,
  CloudUsageTimeSeriesResponse,
  TimeSeriesDataPoint,
} from "./GoogleCloudUsageService.ts";

const PRISM_REQUESTS_COLLECTION = "requests";
// Written by tools-service/src/services/ExternalApiUsageService.ts.
const EXTERNAL_API_USAGE_COLLECTION = "external-api-usage";

// LLM provider identifiers are namespaced so the time-series route can
// tell them apart from hostnames ("llm:openai" vs "api.ebay.com").
const LLM_IDENTIFIER_PREFIX = "llm:";

// ── Provider metadata ──────────────────────────────────────────────

interface ProviderMetadata {
  displayName: string;
  category: string;
  documentationUrl: string;
}

const LLM_PROVIDER_METADATA: Record<string, ProviderMetadata> = {
  [PROVIDERS.OPENAI]: {
    displayName: "OpenAI API",
    category: "AI / LLM",
    documentationUrl: "https://platform.openai.com/docs",
  },
  [PROVIDERS.ANTHROPIC]: {
    displayName: "Anthropic API",
    category: "AI / LLM",
    documentationUrl: "https://docs.anthropic.com",
  },
  [PROVIDERS.MOONSHOT]: {
    displayName: "Moonshot (Kimi) API",
    category: "AI / LLM",
    documentationUrl: "https://platform.moonshot.ai/docs",
  },
  [PROVIDERS.ELEVENLABS]: {
    displayName: "ElevenLabs API",
    category: "Voice",
    documentationUrl: "https://elevenlabs.io/docs",
  },
  [PROVIDERS.INWORLD]: {
    displayName: "Inworld API",
    category: "Voice",
    documentationUrl: "https://docs.inworld.ai",
  },
};

// Known tools-service hosts → friendly provider cards. Multiple hosts can
// collapse into one provider key (e.g. api + accounts endpoints). Anything
// not listed still appears, grouped by hostname with a prettified name.
interface HostProviderMetadata extends ProviderMetadata {
  key: string;
}

const KNOWN_HOST_PROVIDERS: Record<string, HostProviderMetadata> = {
  "api.ebay.com": { key: "api.ebay.com", displayName: "eBay API", category: "Commerce", documentationUrl: "https://developer.ebay.com/docs" },
  "openapi.etsy.com": { key: "openapi.etsy.com", displayName: "Etsy API", category: "Commerce", documentationUrl: "https://developers.etsy.com" },
  "api.spotify.com": { key: "api.spotify.com", displayName: "Spotify Web API", category: "Music", documentationUrl: "https://developer.spotify.com/documentation/web-api" },
  "accounts.spotify.com": { key: "api.spotify.com", displayName: "Spotify Web API", category: "Music", documentationUrl: "https://developer.spotify.com/documentation/web-api" },
  "musicbrainz.org": { key: "musicbrainz.org", displayName: "MusicBrainz API", category: "Music", documentationUrl: "https://musicbrainz.org/doc/MusicBrainz_API" },
  "oauth.reddit.com": { key: "reddit.com", displayName: "Reddit API", category: "Social", documentationUrl: "https://www.reddit.com/dev/api" },
  "www.reddit.com": { key: "reddit.com", displayName: "Reddit API", category: "Social", documentationUrl: "https://www.reddit.com/dev/api" },
  "api.themoviedb.org": { key: "api.themoviedb.org", displayName: "TMDb API", category: "Media", documentationUrl: "https://developer.themoviedb.org" },
  "api.tvmaze.com": { key: "api.tvmaze.com", displayName: "TVMaze API", category: "Media", documentationUrl: "https://www.tvmaze.com/api" },
  "api.jikan.moe": { key: "api.jikan.moe", displayName: "Jikan (MyAnimeList) API", category: "Media", documentationUrl: "https://docs.api.jikan.moe" },
  "api.search.brave.com": { key: "api.search.brave.com", displayName: "Brave Search API", category: "Search", documentationUrl: "https://api-dashboard.search.brave.com/app/documentation" },
  "finnhub.io": { key: "finnhub.io", displayName: "Finnhub API", category: "Finance", documentationUrl: "https://finnhub.io/docs/api" },
  "api.stlouisfed.org": { key: "api.stlouisfed.org", displayName: "FRED API", category: "Finance", documentationUrl: "https://fred.stlouisfed.org/docs/api/fred" },
  "api.eia.gov": { key: "api.eia.gov", displayName: "EIA API", category: "Finance", documentationUrl: "https://www.eia.gov/opendata" },
  "www.eia.gov": { key: "api.eia.gov", displayName: "EIA API", category: "Finance", documentationUrl: "https://www.eia.gov/opendata" },
  "api.nasa.gov": { key: "api.nasa.gov", displayName: "NASA API", category: "Space", documentationUrl: "https://api.nasa.gov" },
  "app.ticketmaster.com": { key: "app.ticketmaster.com", displayName: "Ticketmaster Discovery API", category: "Events", documentationUrl: "https://developer.ticketmaster.com" },
  "api.seatgeek.com": { key: "api.seatgeek.com", displayName: "SeatGeek API", category: "Events", documentationUrl: "https://platform.seatgeek.com" },
  "en.wikipedia.org": { key: "en.wikipedia.org", displayName: "Wikipedia API", category: "Knowledge", documentationUrl: "https://en.wikipedia.org/api/rest_v1" },
  "openlibrary.org": { key: "openlibrary.org", displayName: "Open Library API", category: "Knowledge", documentationUrl: "https://openlibrary.org/developers/api" },
  "restcountries.com": { key: "restcountries.com", displayName: "REST Countries API", category: "Knowledge", documentationUrl: "https://restcountries.com" },
  "api.open-meteo.com": { key: "api.open-meteo.com", displayName: "Open-Meteo API", category: "Weather", documentationUrl: "https://open-meteo.com/en/docs" },
  "hacker-news.firebaseio.com": { key: "hacker-news.firebaseio.com", displayName: "Hacker News API", category: "Social", documentationUrl: "https://github.com/HackerNews/API" },
  "api.producthunt.com": { key: "api.producthunt.com", displayName: "Product Hunt API", category: "Social", documentationUrl: "https://api.producthunt.com/v2/docs" },
  "api.github.com": { key: "api.github.com", displayName: "GitHub API", category: "Utility", documentationUrl: "https://docs.github.com/rest" },
  "ipinfo.io": { key: "ipinfo.io", displayName: "IPinfo API", category: "Utility", documentationUrl: "https://ipinfo.io/developers" },
};

/** "api.some-provider.com" → "Api Some Provider Com" minus noise words. */
function prettifyHostname(hostname: string): string {
  return hostname
    .replace(/^(www|api|apis|app)\./, "")
    .split(/[.-]/)
    .filter((word) => word && word !== "com" && word !== "org" && word !== "net" && word !== "io" && word !== "gov")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function resolveHostProvider(hostname: string): HostProviderMetadata {
  return (
    KNOWN_HOST_PROVIDERS[hostname] ?? {
      key: hostname,
      displayName: prettifyHostname(hostname) || hostname,
      category: "Other",
      documentationUrl: `https://${hostname}`,
    }
  );
}

/** Hosts that roll up into the given provider key (for time-series). */
function hostsForProviderKey(providerKey: string): string[] {
  const hosts = Object.entries(KNOWN_HOST_PROVIDERS)
    .filter(([, metadata]) => metadata.key === providerKey)
    .map(([host]) => host);
  return hosts.length > 0 ? hosts : [providerKey];
}

// ── Types / cache ──────────────────────────────────────────────────

export interface ProviderUsageSummaryResult {
  services: ApiUsageSummary[];
  totalRequests: number;
  totalErrors: number;
  unreachableSources: string[];
}

const usageCache = createTtlCache();
const CACHE_TTL_MILLISECONDS = 5 * 60 * 1000;

function periodToDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : 30;
}

function periodStartIso(period: string): string {
  return new Date(Date.now() - periodToDays(period) * 24 * 60 * 60 * 1000).toISOString();
}

interface DailyAccumulator {
  requests: number;
  successRequests: number;
  errorRequests: number;
}

function accumulateDay(
  buckets: Map<string, DailyAccumulator>,
  date: string,
  requests: number,
  errors: number,
): void {
  const bucket = buckets.get(date) || { requests: 0, successRequests: 0, errorRequests: 0 };
  bucket.requests += requests;
  bucket.errorRequests += errors;
  bucket.successRequests += requests - errors;
  buckets.set(date, bucket);
}

function toSortedDailySeries(buckets: Map<string, DailyAccumulator>) {
  return [...buckets.entries()]
    .map(([date, values]) => ({ date, requests: values.requests }))
    .sort((first, second) => first.date.localeCompare(second.date));
}

// ── Service ────────────────────────────────────────────────────────

export default class ExternalProviderUsageService {
  static isLlmIdentifier(serviceIdentifier: string): boolean {
    return serviceIdentifier.startsWith(LLM_IDENTIFIER_PREFIX);
  }

  static isValidServiceIdentifier(serviceIdentifier: string): boolean {
    return /^(llm:)?[a-z0-9][a-z0-9.-]{0,200}$/.test(serviceIdentifier);
  }

  static async getSummary(period = "30d"): Promise<ProviderUsageSummaryResult> {
    return usageCache.get(`provider-usage:summary:${period}`, CACHE_TTL_MILLISECONDS, () =>
      ExternalProviderUsageService.computeSummary(period),
    );
  }

  private static async computeSummary(period: string): Promise<ProviderUsageSummaryResult> {
    const [llmResult, toolsResult] = await Promise.allSettled([
      ExternalProviderUsageService.aggregateLlmProviders(period),
      ExternalProviderUsageService.aggregateToolsProviders(period),
    ]);

    const services: ApiUsageSummary[] = [];
    const unreachableSources: string[] = [];

    if (llmResult.status === "fulfilled") {
      services.push(...llmResult.value);
    } else {
      unreachableSources.push(`prism (${PRISM_MONGO_DB_NAME})`);
      logger.warn(`[ProviderUsage] LLM source unavailable: ${String(llmResult.reason)}`);
    }

    if (toolsResult.status === "fulfilled") {
      services.push(...toolsResult.value);
    } else {
      unreachableSources.push(`tools (${TOOLS_MONGO_DB_NAME})`);
      logger.warn(`[ProviderUsage] tools source unavailable: ${String(toolsResult.reason)}`);
    }

    services.sort((first, second) => second.totalRequests - first.totalRequests);

    return {
      services,
      totalRequests: services.reduce((sum, service) => sum + service.totalRequests, 0),
      totalErrors: services.reduce((sum, service) => sum + service.errorRequests, 0),
      unreachableSources,
    };
  }

  // ── Source 1: prism `requests` collection ────────────────────────

  private static getPrismRequestsCollection() {
    const database = MongoWrapper.getDb(String(PRISM_MONGO_DB_NAME));
    if (!database) throw new Error(`prism database "${PRISM_MONGO_DB_NAME}" not connected`);
    return database.collection(PRISM_REQUESTS_COLLECTION);
  }

  /**
   * Per-provider daily rollups from prism's request log. `createdAt` is an
   * ISO string, so string comparison and $substrCP both work; $toString
   * keeps any legacy Date-typed values from breaking the pipeline.
   */
  private static async queryLlmDailyRollups(period: string) {
    const collection = ExternalProviderUsageService.getPrismRequestsCollection();
    return collection
      .aggregate<{
        _id: { provider: string; day: string };
        requests: number;
        errors: number;
        estimatedCost: number;
      }>([
        { $match: { createdAt: { $gte: periodStartIso(period) }, provider: { $ne: null } } },
        {
          $group: {
            _id: {
              provider: "$provider",
              day: { $substrCP: [{ $toString: "$createdAt" }, 0, 10] },
            },
            requests: { $sum: 1 },
            // success:null marks mid-turn crash stubs — count only explicit
            // failures as errors so stubs don't inflate provider error rates.
            errors: { $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] } },
            estimatedCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
          },
        },
      ])
      .toArray();
  }

  private static async aggregateLlmProviders(period: string): Promise<ApiUsageSummary[]> {
    const rollups = await ExternalProviderUsageService.queryLlmDailyRollups(period);

    const perProvider = new Map<
      string,
      { requests: number; errors: number; estimatedCost: number; days: Map<string, DailyAccumulator> }
    >();

    for (const rollup of rollups) {
      const provider = resolveProviderBaseType(String(rollup._id.provider || ""));
      // Google traffic is already on the dashboard via Cloud Monitoring
      // (generativelanguage.googleapis.com); local providers aren't external.
      if (!provider || provider === PROVIDERS.GOOGLE || isLocalProvider(provider)) continue;

      let entry = perProvider.get(provider);
      if (!entry) {
        entry = { requests: 0, errors: 0, estimatedCost: 0, days: new Map() };
        perProvider.set(provider, entry);
      }

      entry.requests += rollup.requests;
      entry.errors += rollup.errors;
      entry.estimatedCost += rollup.estimatedCost;
      accumulateDay(entry.days, rollup._id.day, rollup.requests, rollup.errors);
    }

    return [...perProvider.entries()].map(([provider, entry]) => {
      const metadata = LLM_PROVIDER_METADATA[provider] ?? {
        displayName: `${PROVIDER_LABELS[provider] || provider} API`,
        category: "AI / LLM",
        documentationUrl: "",
      };

      return {
        serviceIdentifier: `${LLM_IDENTIFIER_PREFIX}${provider}`,
        displayName: metadata.displayName,
        category: metadata.category,
        consumer: "prism-service",
        documentationUrl: metadata.documentationUrl,
        totalRequests: entry.requests,
        successRequests: entry.requests - entry.errors,
        errorRequests: entry.errors,
        errorRate: entry.requests > 0 ? entry.errors / entry.requests : 0,
        estimatedCost: entry.estimatedCost > 0 ? entry.estimatedCost : undefined,
        dailySeries: toSortedDailySeries(entry.days),
      };
    });
  }

  // ── Source 2: tools-service `external-api-usage` buckets ─────────

  private static getToolsUsageCollection() {
    const database = MongoWrapper.getDb(String(TOOLS_MONGO_DB_NAME));
    if (!database) throw new Error(`tools database "${TOOLS_MONGO_DB_NAME}" not connected`);
    return database.collection(EXTERNAL_API_USAGE_COLLECTION);
  }

  private static async aggregateToolsProviders(period: string): Promise<ApiUsageSummary[]> {
    const collection = ExternalProviderUsageService.getToolsUsageCollection();
    const sinceDate = periodStartIso(period).slice(0, 10);

    const buckets = await collection
      .find<{ service: string; host: string; date: string; requests: number; errors: number }>(
        { date: { $gte: sinceDate } },
      )
      .toArray();

    const perProvider = new Map<
      string,
      {
        metadata: HostProviderMetadata;
        consumers: Set<string>;
        requests: number;
        errors: number;
        days: Map<string, DailyAccumulator>;
      }
    >();

    for (const bucket of buckets) {
      const metadata = resolveHostProvider(bucket.host);

      let entry = perProvider.get(metadata.key);
      if (!entry) {
        entry = { metadata, consumers: new Set(), requests: 0, errors: 0, days: new Map() };
        perProvider.set(metadata.key, entry);
      }

      entry.consumers.add(bucket.service);
      entry.requests += bucket.requests;
      entry.errors += bucket.errors;
      accumulateDay(entry.days, bucket.date, bucket.requests, bucket.errors);
    }

    return [...perProvider.values()].map((entry) => ({
      serviceIdentifier: entry.metadata.key,
      displayName: entry.metadata.displayName,
      category: entry.metadata.category,
      consumer: [...entry.consumers].sort().join(" + "),
      documentationUrl: entry.metadata.documentationUrl,
      totalRequests: entry.requests,
      successRequests: entry.requests - entry.errors,
      errorRequests: entry.errors,
      errorRate: entry.requests > 0 ? entry.errors / entry.requests : 0,
      dailySeries: toSortedDailySeries(entry.days),
    }));
  }

  // ── Time series (expanded card) ───────────────────────────────────

  static async getTimeSeries(
    serviceIdentifier: string,
    period = "30d",
  ): Promise<CloudUsageTimeSeriesResponse> {
    return usageCache.get(
      `provider-usage:timeseries:${serviceIdentifier}:${period}`,
      CACHE_TTL_MILLISECONDS,
      () => ExternalProviderUsageService.computeTimeSeries(serviceIdentifier, period),
    );
  }

  private static async computeTimeSeries(
    serviceIdentifier: string,
    period: string,
  ): Promise<CloudUsageTimeSeriesResponse> {
    const days = ExternalProviderUsageService.isLlmIdentifier(serviceIdentifier)
      ? await ExternalProviderUsageService.computeLlmTimeSeries(serviceIdentifier, period)
      : await ExternalProviderUsageService.computeToolsTimeSeries(serviceIdentifier, period);

    const series: TimeSeriesDataPoint[] = [...days.entries()]
      .map(([date, values]) => ({ date, ...values }))
      .sort((first, second) => first.date.localeCompare(second.date));

    const displayName = ExternalProviderUsageService.isLlmIdentifier(serviceIdentifier)
      ? (LLM_PROVIDER_METADATA[serviceIdentifier.slice(LLM_IDENTIFIER_PREFIX.length)]?.displayName ??
        serviceIdentifier)
      : resolveHostProvider(serviceIdentifier).displayName;

    return {
      serviceIdentifier,
      displayName,
      series,
      period,
      fetchedAt: new Date().toISOString(),
    };
  }

  private static async computeLlmTimeSeries(serviceIdentifier: string, period: string) {
    const provider = serviceIdentifier.slice(LLM_IDENTIFIER_PREFIX.length);
    const rollups = await ExternalProviderUsageService.queryLlmDailyRollups(period);

    const days = new Map<string, DailyAccumulator>();
    for (const rollup of rollups) {
      if (resolveProviderBaseType(String(rollup._id.provider || "")) !== provider) continue;
      accumulateDay(days, rollup._id.day, rollup.requests, rollup.errors);
    }
    return days;
  }

  private static async computeToolsTimeSeries(serviceIdentifier: string, period: string) {
    const collection = ExternalProviderUsageService.getToolsUsageCollection();
    const sinceDate = periodStartIso(period).slice(0, 10);

    const buckets = await collection
      .find<{ host: string; date: string; requests: number; errors: number }>({
        host: { $in: hostsForProviderKey(serviceIdentifier) },
        date: { $gte: sinceDate },
      })
      .toArray();

    const days = new Map<string, DailyAccumulator>();
    for (const bucket of buckets) {
      accumulateDay(days, bucket.date, bucket.requests, bucket.errors);
    }
    return days;
  }
}

// Exported for tests only.
export const __internal = {
  KNOWN_HOST_PROVIDERS,
  LLM_PROVIDER_METADATA,
  prettifyHostname,
  resolveHostProvider,
  hostsForProviderKey,
};
