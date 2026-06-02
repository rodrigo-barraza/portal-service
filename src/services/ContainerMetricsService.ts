import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../config.ts";
import { COLLECTIONS } from "../constants.ts";
import logger from "../utils/logger.ts";
import type { ContainerStats, MetricsHistoryResult } from "../types.ts";
import { DateHelpers } from "../utils/DateHelpers.ts";

interface AggregateHistoryDocument {
  _id: {
    container: string;
    device: string;
  };
  points: {
    t: Date;
    cpu: number;
    mem: number;
    memLimit: number;
    netRx: number;
    netTx: number;
    pids: number;
  }[];
}

const PERSIST_INTERVAL_MS = 30_000;
const TTL_DAYS = 7;
const TTL_SECONDS = TTL_DAYS * 24 * 60 * 60;

export default class ContainerMetricsService {
  static _timer: ReturnType<typeof setTimeout> | null = null;
  static _initialized = false;

  public static async ensureCollection(): Promise<void> {
    const db = MongoWrapper.getDb(String(MONGO_DB_NAME));
    if (!db) {
      logger.warn("[ContainerMetrics] MongoDB not connected — skipping collection setup");
      return;
    }

    try {
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

      const metricsCollection = db.collection(COLLECTIONS.CONTAINER_METRICS);
      await metricsCollection.createIndex(
        { "metadata.container": 1, "metadata.device": 1, timestamp: -1 },
        { name: "container_device_time_desc" },
      );

      ContainerMetricsService._initialized = true;
      logger.success("[ContainerMetrics] Indexes ensured");
    } catch (error: unknown) {
      if (error && typeof error === "object" && "codeName" in error && error.codeName === "NamespaceExists") {
        ContainerMetricsService._initialized = true;
        logger.info("[ContainerMetrics] Collection already exists");
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[ContainerMetrics] Setup failed: ${errorMessage}`);
      }
    }
  }

  public static async persistSnapshot(deviceId: string, containers: ContainerStats[]): Promise<void> {
    if (!ContainerMetricsService._initialized) return;

    const db = MongoWrapper.getDb(String(MONGO_DB_NAME));
    if (!db) return;

    const metricsCollection = db.collection(COLLECTIONS.CONTAINER_METRICS);
    const now = new Date();

    const documents = containers
      .filter((containerStats) => containerStats.cpu && containerStats.memory)
      .map((containerStats) => ({
        timestamp: now,
        metadata: {
          container: containerStats.name,
          device: deviceId,
        },
        cpu: containerStats.cpu.percent,
        memoryUsed: containerStats.memory.used,
        memoryLimit: containerStats.memory.limit,
        memoryPercent: containerStats.memory.percent,
        netRx: containerStats.network?.rx || 0,
        netTx: containerStats.network?.tx || 0,
        blockRead: containerStats.blockIO?.read || 0,
        blockWrite: containerStats.blockIO?.write || 0,
        pids: containerStats.pids || 0,
      }));

    if (documents.length === 0) return;

    try {
      await metricsCollection.insertMany(documents, { ordered: false });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[ContainerMetrics] Insert failed: ${errorMessage}`);
    }
  }

  public static async getHistory({
    container,
    device,
    range = "1h",
    limit = 120,
  }: {
    container?: string;
    device?: string;
    range?: string;
    limit?: number;
  } = {}): Promise<MetricsHistoryResult> {
    const db = MongoWrapper.getDb(String(MONGO_DB_NAME));
    if (!db) return { containers: {}, range, samples: 0 };

    const metricsCollection = db.collection(COLLECTIONS.CONTAINER_METRICS);

    const rangeMs = DateHelpers.parseRangeToMilliseconds(range);
    const since = new Date(Date.now() - rangeMs);

    const match: Record<string, unknown> = { timestamp: { $gte: since } };
    if (container) match["metadata.container"] = container;
    if (device) match["metadata.device"] = device;

    const bucketCount = Math.min(limit, 120);

    try {
      const pipeline: Record<string, unknown>[] = [
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
          $project: {
            points: { $slice: ["$points", -bucketCount] },
          },
        },
      ];

      const results = await metricsCollection.aggregate(pipeline).toArray();

      const containers: MetricsHistoryResult["containers"] = {};
      let totalSamples = 0;

      for (const doc of results as unknown as AggregateHistoryDocument[]) {
        const name = doc._id.container;
        containers[name] = {
          device: doc._id.device,
          points: doc.points.map((point) => ({
            t: point.t,
            cpu: Math.round(point.cpu * 100) / 100,
            mem: point.mem,
            memLimit: point.memLimit,
            netRx: point.netRx,
            netTx: point.netTx,
            pids: point.pids,
          })),
        };
        totalSamples += doc.points.length;
      }

      return { containers, range, since: since.toISOString(), samples: totalSamples };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[ContainerMetrics] Query failed: ${errorMessage}`);
      return { containers: {}, range, samples: 0 };
    }
  }

  public static get persistIntervalMs(): number {
    return PERSIST_INTERVAL_MS;
  }
}
