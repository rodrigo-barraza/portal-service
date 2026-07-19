// ─── MinIO Storage Service ──────────────────────────────────

import { createHmac } from "node:crypto";
import { Client } from "minio";
import {
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
} from "../config.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

interface MinioObjectEntry {
  name: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
}

export interface BucketUsage {
  objectCount: number;
  totalSize: number;
}

interface BucketSummary {
  name: string;
  creationDate: string | null;
  objectCount: number | null;
  totalSize: number | null;
}

export type BucketStreamServerEvent =
  | { type: "init"; totalBuckets: number; buckets: BucketSummary[] }
  | { type: "bucket"; bucket: BucketSummary };

export interface BucketStatsSnapshot {
  usage: Map<string, BucketUsage>;
  source: "metrics" | "scan";
  collectedAt: number;
}

// Bucket counts/sizes come from MinIO's Prometheus metrics when possible —
// the scanner already tracks per-bucket usage, so one scrape replaces a full
// object enumeration. The enumeration only runs as a fallback (metrics
// endpoint unreachable/empty) and its result is cached longer because it
// costs one S3 list round-trip per 1000 objects.
const METRICS_FRESH_TTL_MS = 30 * 1000;
const SCAN_FRESH_TTL_MS = 10 * 60 * 1000;
const METRICS_TIMEOUT_MS = 5_000;
const SCAN_CONCURRENCY = 4;

const METRIC_PATHS = ["/minio/v2/metrics/bucket", "/minio/v2/metrics/cluster"];
const BUCKET_USAGE_METRIC_PATTERN =
  /^minio_bucket_usage_(total_bytes|object_total)\{([^}]*)\}\s+(\S+)/;

let statsSnapshot: BucketStatsSnapshot | null = null;
let statsRefreshInflight: Promise<BucketStatsSnapshot> | null = null;

function snapshotIsFresh(snapshot: BucketStatsSnapshot) {
  const ttl =
    snapshot.source === "metrics" ? METRICS_FRESH_TTL_MS : SCAN_FRESH_TTL_MS;
  return Date.now() - snapshot.collectedAt < ttl;
}

function base64url(input: Buffer | string) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export default class MinioService {
  static client: Client | null = null;

  static _getClient() {
    if (MinioService.client) return MinioService.client;

    if (!MINIO_ENDPOINT) {
      throw new Error("No MINIO_ENDPOINT configured");
    }

    const url = new URL(MINIO_ENDPOINT);
    MinioService.client = new Client({
      endPoint: url.hostname,
      port: parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
      useSSL: url.protocol === "https:",
      accessKey: MINIO_ACCESS_KEY || "",
      secretKey: MINIO_SECRET_KEY || "",
    });

    logger.info(`[MinioService] Client initialized → ${MINIO_ENDPOINT}`);
    return MinioService.client;
  }

  // ── Bucket usage stats (metrics-first, scan fallback) ────────

  /**
   * Bearer token for MinIO's Prometheus endpoints — the same JWT
   * `mc admin prometheus generate` produces: HS512, issuer "prometheus",
   * subject = access key, signed with the secret key.
   */
  static _generatePrometheusToken(): string | null {
    if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) return null;

    const header = base64url(JSON.stringify({ alg: "HS512", typ: "JWT" }));
    const payload = base64url(
      JSON.stringify({
        iss: "prometheus",
        sub: MINIO_ACCESS_KEY,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const signature = createHmac("sha512", MINIO_SECRET_KEY)
      .update(`${header}.${payload}`)
      .digest();
    return `${header}.${payload}.${base64url(signature)}`;
  }

  /**
   * Parse per-bucket usage out of a Prometheus metrics exposition.
   * Multi-node deployments repeat metrics per server label — max (not sum)
   * per bucket avoids double counting.
   */
  static _parseBucketMetrics(metricsText: string): Map<string, BucketUsage> {
    const usage = new Map<string, BucketUsage>();

    for (const line of metricsText.split("\n")) {
      const match = BUCKET_USAGE_METRIC_PATTERN.exec(line);
      if (!match) continue;

      const [, metricKind, labels, rawValue] = match;
      const bucketMatch = /(?:^|,)bucket="([^"]+)"/.exec(labels);
      if (!bucketMatch) continue;

      const bucketName = bucketMatch[1];
      const value = Number.parseFloat(rawValue);
      if (!Number.isFinite(value)) continue;

      const entry = usage.get(bucketName) || { objectCount: 0, totalSize: 0 };
      if (metricKind === "total_bytes") {
        entry.totalSize = Math.max(entry.totalSize, value);
      } else {
        entry.objectCount = Math.max(entry.objectCount, value);
      }
      usage.set(bucketName, entry);
    }

    return usage;
  }

  /** Fetch per-bucket usage from MinIO's metrics endpoint, or null on any failure. */
  static async _fetchUsageFromMetrics(): Promise<Map<string, BucketUsage> | null> {
    if (!MINIO_ENDPOINT) return null;
    const token = MinioService._generatePrometheusToken();
    if (!token) return null;

    for (const path of METRIC_PATHS) {
      try {
        const response = await fetch(`${MINIO_ENDPOINT}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
        });
        if (!response.ok) continue;

        const usage = MinioService._parseBucketMetrics(await response.text());
        if (usage.size > 0) return usage;
      } catch (error: unknown) {
        logger.warn(`[MinioService] Metrics fetch failed (${path}): ${getErrorMessage(error)}`);
      }
    }

    return null;
  }

  /** Count one bucket the slow way — a full recursive object enumeration. */
  static async _countBucket(bucketName: string): Promise<BucketUsage> {
    const minioClient = MinioService._getClient();
    let objectCount = 0;
    let totalSize = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        const stream = minioClient.listObjectsV2(bucketName, "", true);
        stream.on("data", (object) => {
          objectCount++;
          totalSize += object.size || 0;
        });
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    } catch (error: unknown) {
      logger.warn(`[MinioService] Failed to count objects in ${bucketName}: ${getErrorMessage(error)}`);
    }

    return { objectCount, totalSize };
  }

  /**
   * Scan buckets with bounded concurrency, yielding each result as soon as
   * its bucket finishes — the SSE stream forwards them incrementally.
   */
  static async *_scanUsageIncremental(
    bucketNames: string[],
  ): AsyncGenerator<{ name: string; usage: BucketUsage }> {
    const queue = [...bucketNames];
    const ready: Array<{ name: string; usage: BucketUsage }> = [];
    let notify: (() => void) | null = null;

    const workers = Array.from(
      { length: Math.min(SCAN_CONCURRENCY, queue.length) },
      async () => {
        for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
          const usage = await MinioService._countBucket(name);
          ready.push({ name, usage });
          notify?.();
        }
      },
    );

    let allDone = false;
    Promise.all(workers).then(() => {
      allDone = true;
      notify?.();
    });

    while (true) {
      if (ready.length > 0) {
        yield ready.shift()!;
        continue;
      }
      if (allDone) break;
      await new Promise<void>((resolve) => { notify = resolve; });
      notify = null;
    }
  }

  /**
   * Per-bucket usage with stale-while-revalidate caching. Fresh snapshot →
   * returned as-is; stale → returned immediately while a refresh runs in the
   * background; missing → awaited.
   */
  static async getBucketUsage(): Promise<BucketStatsSnapshot> {
    if (statsSnapshot && snapshotIsFresh(statsSnapshot)) return statsSnapshot;

    const refresh = MinioService._refreshUsage();
    if (statsSnapshot) {
      refresh.catch(() => {}); // background refresh; stale answer is fine
      return statsSnapshot;
    }
    return refresh;
  }

  static async _refreshUsage(): Promise<BucketStatsSnapshot> {
    if (statsRefreshInflight) return statsRefreshInflight;

    statsRefreshInflight = (async () => {
      const startedAt = Date.now();
      const fromMetrics = await MinioService._fetchUsageFromMetrics();
      if (fromMetrics) {
        statsSnapshot = { usage: fromMetrics, source: "metrics", collectedAt: Date.now() };
        logger.info(`[MinioService] Bucket usage via metrics — ${fromMetrics.size} buckets in ${Date.now() - startedAt}ms`);
        return statsSnapshot;
      }

      const minioClient = MinioService._getClient();
      const names = (await minioClient.listBuckets()).map((bucket) => bucket.name);
      const usage = new Map<string, BucketUsage>();
      for await (const result of MinioService._scanUsageIncremental(names)) {
        usage.set(result.name, result.usage);
      }
      statsSnapshot = { usage, source: "scan", collectedAt: Date.now() };
      logger.info(`[MinioService] Bucket usage via full scan — ${names.length} buckets in ${Date.now() - startedAt}ms`);
      return statsSnapshot;
    })().finally(() => {
      statsRefreshInflight = null;
    });

    return statsRefreshInflight;
  }

  static async listBuckets() {
    const minioClient = MinioService._getClient();
    const [rawBuckets, stats] = await Promise.all([
      minioClient.listBuckets(),
      MinioService.getBucketUsage(),
    ]);

    return rawBuckets.map((bucket) => {
      const usage = stats.usage.get(bucket.name);
      return {
        name: bucket.name,
        creationDate: bucket.creationDate?.toISOString() || null,
        objectCount: usage?.objectCount ?? 0,
        totalSize: usage?.totalSize ?? 0,
      };
    });
  }

  static async *streamBuckets(): AsyncGenerator<BucketStreamServerEvent> {
    const minioClient = MinioService._getClient();
    const rawBuckets = await minioClient.listBuckets();

    // Names + creation dates are known instantly — send them all up front so
    // the client can render every card immediately and fill stats in as they
    // arrive. objectCount/totalSize are null until a `bucket` event lands.
    yield {
      type: "init",
      totalBuckets: rawBuckets.length,
      buckets: rawBuckets.map((bucket) => ({
        name: bucket.name,
        creationDate: bucket.creationDate?.toISOString() || null,
        objectCount: null,
        totalSize: null,
      })),
    };

    const bucketDates = new Map(
      rawBuckets.map((bucket) => [bucket.name, bucket.creationDate?.toISOString() || null]),
    );
    const bucketEvent = (name: string, usage: BucketUsage): BucketStreamServerEvent => ({
      type: "bucket",
      bucket: {
        name,
        creationDate: bucketDates.get(name) || null,
        objectCount: usage.objectCount,
        totalSize: usage.totalSize,
      },
    });

    // Fast path: cached or metrics-derived usage answers every bucket at once
    if (statsSnapshot && snapshotIsFresh(statsSnapshot)) {
      for (const bucket of rawBuckets) {
        yield bucketEvent(bucket.name, statsSnapshot.usage.get(bucket.name) || { objectCount: 0, totalSize: 0 });
      }
      return;
    }

    const fromMetrics = await MinioService._fetchUsageFromMetrics();
    if (fromMetrics) {
      statsSnapshot = { usage: fromMetrics, source: "metrics", collectedAt: Date.now() };
      logger.info(`[MinioService] Bucket usage via metrics — ${fromMetrics.size} buckets`);
      for (const bucket of rawBuckets) {
        yield bucketEvent(bucket.name, fromMetrics.get(bucket.name) || { objectCount: 0, totalSize: 0 });
      }
      return;
    }

    // Slow path: enumerate. If a refresh is already running (e.g. the
    // /stats/storage summary fired in the same page load), wait for it
    // instead of scanning twice.
    if (statsRefreshInflight) {
      const snapshot = await statsRefreshInflight;
      for (const bucket of rawBuckets) {
        yield bucketEvent(bucket.name, snapshot.usage.get(bucket.name) || { objectCount: 0, totalSize: 0 });
      }
      return;
    }

    // Lead the refresh ourselves so we can emit each bucket as its scan
    // completes; concurrent callers await the same promise. The snapshot is
    // only cached when the scan ran to completion (a client disconnect
    // mid-stream must not persist half-zeroed stats).
    let settle!: (snapshot: BucketStatsSnapshot) => void;
    statsRefreshInflight = new Promise<BucketStatsSnapshot>((resolve) => {
      settle = resolve;
    });

    const usage = new Map<string, BucketUsage>();
    let completed = false;
    try {
      for await (const result of MinioService._scanUsageIncremental(
        rawBuckets.map((bucket) => bucket.name),
      )) {
        usage.set(result.name, result.usage);
        yield bucketEvent(result.name, result.usage);
      }
      completed = true;
      statsSnapshot = { usage, source: "scan", collectedAt: Date.now() };
    } finally {
      settle(
        completed
          ? statsSnapshot!
          : { usage, source: "scan", collectedAt: 0 }, // stale-on-arrival: never served as fresh
      );
      statsRefreshInflight = null;
    }
  }

  static async listObjects(bucketName: string, prefix: string = "", recursive: boolean = false) {
    const minioClient = MinioService._getClient();

    return new Promise<{ objects: MinioObjectEntry[], prefixes: string[] }>((resolve, reject) => {
      const objects: MinioObjectEntry[] = [];
      const prefixes = new Set<string>();

      const stream = minioClient.listObjectsV2(bucketName, prefix, recursive);

      stream.on("data", (item) => {
        if (item.prefix) {
          // Virtual directory
          prefixes.add(item.prefix);
        } else {
          objects.push({
            name: item.name || "",
            size: item.size,
            lastModified: item.lastModified?.toISOString() || null,
            etag: item.etag || null,
          });
        }
      });

      stream.on("end", () => {
        resolve({
          objects,
          prefixes: [...prefixes].sort(),
        });
      });

      stream.on("error", reject);
    });
  }

  static async statObject(bucketName: string, objectName: string) {
    const minioClient = MinioService._getClient();
    return minioClient.statObject(bucketName, objectName);
  }

  static async getObject(bucketName: string, objectName: string) {
    const minioClient = MinioService._getClient();
    return minioClient.getObject(bucketName, objectName);
  }

  static async getPartialObject(bucketName: string, objectName: string, offset: number, length: number) {
    const minioClient = MinioService._getClient();
    return minioClient.getPartialObject(bucketName, objectName, offset, length);
  }

  static async deleteObject(bucketName: string, objectName: string) {
    const minioClient = MinioService._getClient();
    return minioClient.removeObject(bucketName, objectName);
  }

  static async searchObjects(
    query: string,
    { bucket, limit = 200 }: { bucket?: string; limit?: number } = {},
  ): Promise<{ results: Array<MinioObjectEntry & { bucket: string }>; totalScanned: number; truncated: boolean }> {
    const minioClient = MinioService._getClient();
    const normalizedQuery = query.toLowerCase();
    const results: Array<MinioObjectEntry & { bucket: string }> = [];
    let totalScanned = 0;
    let truncated = false;

    const bucketsToSearch = bucket
      ? [{ name: bucket }]
      : (await minioClient.listBuckets()).map((bucketItem) => ({ name: bucketItem.name }));

    for (const targetBucket of bucketsToSearch) {
      if (truncated) break;

      await new Promise<void>((resolve, reject) => {
        const stream = minioClient.listObjectsV2(targetBucket.name, "", true);

        stream.on("data", (item) => {
          if (item.prefix) return;
          totalScanned++;

          const objectName = item.name || "";
          if (objectName.toLowerCase().includes(normalizedQuery)) {
            results.push({
              name: objectName,
              size: item.size,
              lastModified: item.lastModified?.toISOString() || null,
              etag: item.etag || null,
              bucket: targetBucket.name,
            });

            if (results.length >= limit) {
              truncated = true;
              stream.destroy();
              resolve();
              return;
            }
          }
        });

        stream.on("end", resolve);
        stream.on("error", reject);
      });
    }

    return { results, totalScanned, truncated };
  }
}
