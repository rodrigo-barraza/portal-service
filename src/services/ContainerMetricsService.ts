// ─── Container Metrics Persistence Service ──────────────────
// Persists Docker container CPU/memory/network snapshots to a
// MongoDB time-series collection for historical trend analysis.
// Downsamples writes to 30s intervals while the ring buffer
// in DockerStatsService continues at 5s for live polling.

import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../config.ts";
import { COLLECTIONS } from "../constants.ts";
import logger from "../utils/logger.ts";

// ── Configuration ────────────────────────────────────────────────
const PERSIST_INTERVAL_MS = 30_000;       // Write one sample every 30s
const TTL_DAYS = 7;                        // Auto-expire after 7 days
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

export default class ContainerMetricsService {
  static _timer: any = null;
  static _initialized = false;

  /**
   * Ensure the time-series collection and indexes exist.
   * Called once during startup after MongoDB is connected.
   */
  static async ensureCollection(): Promise<void> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME as string);
    if (!db) {
      logger.warn("[ContainerMetrics] MongoDB not connected — skipping collection setup");
      return;
    }

    try {
      // Check if collection already exists (time-series can't be modified after creation)
      const collections = await db.listCollections({ name: COLLECTIONS.CONTAINER_METRICS }).toArray();

      if (collections.length === 0) {
        await db.createCollection(COLLECTIONS.CONTAINER_METRICS, {
          timeseries: {
            timeField: "timestamp",
            metaField: "metadata",
            granularity: "seconds",
          },
          expireAfterSeconds: TTL_SECONDS,
        });
        logger.success(`[ContainerMetrics] Created time-series collection "${COLLECTIONS.CONTAINER_METRICS}" (TTL: ${TTL_DAYS}d)`);
      }

      // Compound index on metadata fields for efficient per-container queries
      const col = db.collection(COLLECTIONS.CONTAINER_METRICS);
      await col.createIndex(
        { "metadata.container": 1, "metadata.device": 1, timestamp: -1 },
        { name: "container_device_time_desc" },
      );

      ContainerMetricsService._initialized = true;
      logger.success("[ContainerMetrics] Indexes ensured");
    } catch (error: any) {
      // If collection already exists with different options, that's fine
      if (error.codeName === "NamespaceExists") {
        ContainerMetricsService._initialized = true;
        logger.info("[ContainerMetrics] Collection already exists");
      } else {
        logger.error(`[ContainerMetrics] Setup failed: ${error.message}`);
      }
    }
  }

  /**
   * Persist a batch of container stats to MongoDB.
   * Called from DockerStatsService after each snapshot collection.
   */
  static async persistSnapshot(deviceId: string, containers: any[]): Promise<void> {
    if (!ContainerMetricsService._initialized) return;

    const db = MongoWrapper.getDb(MONGO_DB_NAME as string);
    if (!db) return;

    const col = db.collection(COLLECTIONS.CONTAINER_METRICS);
    const now = new Date();

    const documents = containers
      .filter((c: any) => c.cpu && c.memory)
      .map((c: any) => ({
        timestamp: now,
        metadata: {
          container: c.name,
          device: deviceId,
        },
        cpu: c.cpu.percent,
        memoryUsed: c.memory.used,
        memoryLimit: c.memory.limit,
        memoryPercent: c.memory.percent,
        netRx: c.network?.rx || 0,
        netTx: c.network?.tx || 0,
        blockRead: c.blockIO?.read || 0,
        blockWrite: c.blockIO?.write || 0,
        pids: c.pids || 0,
      }));

    if (documents.length === 0) return;

    try {
      await col.insertMany(documents, { ordered: false });
    } catch (error: any) {
      logger.warn(`[ContainerMetrics] Insert failed: ${error.message}`);
    }
  }

  /**
   * Query historical metrics for all containers, or filtered by container/device.
   *
   * @param options.container - Filter by container name
   * @param options.device    - Filter by device ID
   * @param options.range     - Time range: "1h", "6h", "24h", "7d" (default: "1h")
   * @param options.limit     - Max samples per container (default: 120)
   */
  static async getHistory({
    container,
    device,
    range = "1h",
    limit = 120,
  }: {
    container?: string;
    device?: string;
    range?: string;
    limit?: number;
  } = {}): Promise<any> {
    const db = MongoWrapper.getDb(MONGO_DB_NAME as string);
    if (!db) return { containers: {}, range, samples: 0 };

    const col = db.collection(COLLECTIONS.CONTAINER_METRICS);

    // Parse time range
    const rangeMs = ContainerMetricsService._parseRange(range);
    const since = new Date(Date.now() - rangeMs);

    // Build match filter
    const match: any = { timestamp: { $gte: since } };
    if (container) match["metadata.container"] = container;
    if (device) match["metadata.device"] = device;

    // For longer ranges, use $bucketAuto to downsample and reduce payload
    const bucketCount = Math.min(limit, 120);

    try {
      const pipeline: any[] = [
        { $match: match },
        { $sort: { "metadata.container": 1, timestamp: 1 } },
        {
          $group: {
            _id: {
              container: "$metadata.container",
              device: "$metadata.device",
            },
            points: {
              $push: {
                t: "$timestamp",
                cpu: "$cpu",
                mem: "$memoryUsed",
                memLimit: "$memoryLimit",
                netRx: "$netRx",
                netTx: "$netTx",
                pids: "$pids",
              },
            },
          },
        },
        {
          // Trim to `limit` most recent points per container
          $project: {
            points: { $slice: ["$points", -bucketCount] },
          },
        },
      ];

      const results = await col.aggregate(pipeline).toArray();

      // Reshape into { containerName: { device, points: [...] } }
      const containers: Record<string, any> = {};
      let totalSamples = 0;

      for (const doc of results) {
        const name = doc._id.container;
        containers[name] = {
          device: doc._id.device,
          points: doc.points.map((p: any) => ({
            t: p.t,
            cpu: Math.round(p.cpu * 100) / 100,
            mem: p.mem,
            memLimit: p.memLimit,
            netRx: p.netRx,
            netTx: p.netTx,
            pids: p.pids,
          })),
        };
        totalSamples += doc.points.length;
      }

      return { containers, range, since: since.toISOString(), samples: totalSamples };
    } catch (error: any) {
      logger.error(`[ContainerMetrics] Query failed: ${error.message}`);
      return { containers: {}, range, samples: 0 };
    }
  }

  /**
   * Parse a human-readable range string into milliseconds.
   */
  static _parseRange(range: string): number {
    const match = range.match(/^(\d+)(m|h|d)$/);
    if (!match) return 60 * 60 * 1000; // default 1h

    const value = parseInt(match[1], 10);
    switch (match[2]) {
      case "m": return value * 60 * 1000;
      case "h": return value * 60 * 60 * 1000;
      case "d": return value * 24 * 60 * 60 * 1000;
      default:  return 60 * 60 * 1000;
    }
  }

  /**
   * Get the persist interval (used by DockerStatsService to throttle writes).
   */
  static get persistIntervalMs(): number {
    return PERSIST_INTERVAL_MS;
  }
}
