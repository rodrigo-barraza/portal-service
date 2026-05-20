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

  /**
   * Ensure the MinIO client is initialized.

   */
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
  /**
   * List all buckets with creation dates and object counts.
   */
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

  /**
   * Async generator that yields enriched bucket objects one-by-one
   * as each completes its object enumeration.
   * Used by the SSE streaming endpoint for progressive loading.
   * @yields {{ name: string, creationDate: string, objectCount: number, totalSize: number }}
   */
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

  /**
   * List objects in a bucket, optionally filtered by prefix.
   * Returns a flat list with virtual "folder" grouping via commonPrefixes.


   */
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

  /**
   * Get metadata for a single object.


   */
  static async statObject(bucketName: string, objectName: string) {
    const mc = MinioService._getClient();
    return mc.statObject(bucketName, objectName);
  }

  /**
   * Get a readable stream for an object.


   */
  static async getObject(bucketName: string, objectName: string) {
    const mc = MinioService._getClient();
    return mc.getObject(bucketName, objectName);
  }

  /**
   * Delete an object from a bucket.


   */
  static async deleteObject(bucketName: string, objectName: string) {
    const mc = MinioService._getClient();
    return mc.removeObject(bucketName, objectName);
  }
}
