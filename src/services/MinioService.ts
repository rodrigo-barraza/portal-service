// ─── MinIO Storage Service ──────────────────────────────────

import { Client } from "minio";
import {
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
} from "../config.ts";
import logger from "../utils/logger.ts";

interface MinioObjectEntry {
  name: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
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
    static async listBuckets() {
    const mc = MinioService._getClient();
    const rawBuckets = await mc.listBuckets();

    // Gather object counts + total sizes in parallel
    const enriched = await Promise.all(
      rawBuckets.map(async (bucket) => {
        let objectCount = 0;
        let totalSize = 0;

        try {
          await new Promise<void>((resolve, reject) => {
            const stream = mc.listObjectsV2(bucket.name, "", true);
            stream.on("data", (object) => {
              objectCount++;
              totalSize += object.size || 0;
            });
            stream.on("end", resolve);
            stream.on("error", reject);
          });
        } catch (error: unknown) {
          logger.warn(`[MinioService] Failed to count objects in ${bucket.name}: ${(error as Error).message}`);
        }

        return {
          name: bucket.name,
          creationDate: bucket.creationDate?.toISOString() || null,
          objectCount,
          totalSize,
        };
      }),
    );

    return enriched;
  }

    static async *streamBuckets() {
    const mc = MinioService._getClient();
    const rawBuckets = await mc.listBuckets();

    // Yield the total count first so the client knows how many to expect
    yield { type: "init", totalBuckets: rawBuckets.length };

    for (const bucket of rawBuckets) {
      let objectCount = 0;
      let totalSize = 0;

      try {
        await new Promise<void>((resolve, reject) => {
          const stream = mc.listObjectsV2(bucket.name, "", true);
          stream.on("data", (object) => {
            objectCount++;
            totalSize += object.size || 0;
          });
          stream.on("end", resolve);
          stream.on("error", reject);
        });
      } catch (error: unknown) {
        logger.warn(`[MinioService] Failed to count objects in ${bucket.name}: ${(error as Error).message}`);
      }

      yield {
        type: "bucket",
        bucket: {
          name: bucket.name,
          creationDate: bucket.creationDate?.toISOString() || null,
          objectCount,
          totalSize,
        },
      };
    }
  }

    static async listObjects(bucketName: string, prefix: string = "", recursive: boolean = false) {
    const mc = MinioService._getClient();

    return new Promise<{ objects: MinioObjectEntry[], prefixes: string[] }>((resolve, reject) => {
      const objects: MinioObjectEntry[] = [];
      const prefixes = new Set<string>();

      const stream = mc.listObjectsV2(bucketName, prefix, recursive);

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
    const mc = MinioService._getClient();
    return mc.statObject(bucketName, objectName);
  }

    static async getObject(bucketName: string, objectName: string) {
    const mc = MinioService._getClient();
    return mc.getObject(bucketName, objectName);
  }

    static async deleteObject(bucketName: string, objectName: string) {
    const mc = MinioService._getClient();
    return mc.removeObject(bucketName, objectName);
  }

    static async searchObjects(
    query: string,
    { bucket, limit = 200 }: { bucket?: string; limit?: number } = {},
  ): Promise<{ results: Array<MinioObjectEntry & { bucket: string }>; totalScanned: number; truncated: boolean }> {
    const mc = MinioService._getClient();
    const normalizedQuery = query.toLowerCase();
    const results: Array<MinioObjectEntry & { bucket: string }> = [];
    let totalScanned = 0;
    let truncated = false;

    const bucketsToSearch = bucket
      ? [{ name: bucket }]
      : (await mc.listBuckets()).map((b) => ({ name: b.name }));

    for (const targetBucket of bucketsToSearch) {
      if (truncated) break;

      await new Promise<void>((resolve, reject) => {
        const stream = mc.listObjectsV2(targetBucket.name, "", true);

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
