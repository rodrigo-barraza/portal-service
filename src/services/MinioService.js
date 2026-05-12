// ─── MinIO Storage Service ──────────────────────────────────

import { Client } from "minio";
import {
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
} from "../config.js";
import logger from "../utils/logger.js";

let client = null;

/**
 * Ensure the MinIO client is initialized.
 * @returns {Client}
 */
function getClient() {
  if (client) return client;

  if (!MINIO_ENDPOINT) {
    throw new Error("No MINIO_ENDPOINT configured");
  }

  const url = new URL(MINIO_ENDPOINT);
  client = new Client({
    endPoint: url.hostname,
    port: parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
    useSSL: url.protocol === "https:",
    accessKey: MINIO_ACCESS_KEY || "",
    secretKey: MINIO_SECRET_KEY || "",
  });

  logger.info(`[MinioService] Client initialized → ${MINIO_ENDPOINT}`);
  return client;
}

export default class MinioService {
  /**
   * List all buckets with creation dates and object counts.
   * @returns {Promise<Array<{ name: string, creationDate: string, objectCount: number, totalSize: number }>>}
   */
  static async listBuckets() {
    const mc = getClient();
    const rawBuckets = await mc.listBuckets();

    // Gather object counts + total sizes in parallel
    const enriched = await Promise.all(
      rawBuckets.map(async (bucket) => {
        let objectCount = 0;
        let totalSize = 0;

        try {
          await new Promise((resolve, reject) => {
            const stream = mc.listObjectsV2(bucket.name, "", true);
            stream.on("data", (obj) => {
              objectCount++;
              totalSize += obj.size || 0;
            });
            stream.on("end", resolve);
            stream.on("error", reject);
          });
        } catch (err) {
          logger.warn(`[MinioService] Failed to count objects in ${bucket.name}: ${err.message}`);
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
    const mc = getClient();
    const rawBuckets = await mc.listBuckets();

    // Yield the total count first so the client knows how many to expect
    yield { type: "init", totalBuckets: rawBuckets.length };

    for (const bucket of rawBuckets) {
      let objectCount = 0;
      let totalSize = 0;

      try {
        await new Promise((resolve, reject) => {
          const stream = mc.listObjectsV2(bucket.name, "", true);
          stream.on("data", (obj) => {
            objectCount++;
            totalSize += obj.size || 0;
          });
          stream.on("end", resolve);
          stream.on("error", reject);
        });
      } catch (err) {
        logger.warn(`[MinioService] Failed to count objects in ${bucket.name}: ${err.message}`);
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
   * @param {string} bucketName
   * @param {string} [prefix=""]
   * @param {boolean} [recursive=false]
   * @returns {Promise<{ objects: Array, prefixes: string[] }>}
   */
  static async listObjects(bucketName, prefix = "", recursive = false) {
    const mc = getClient();

    return new Promise((resolve, reject) => {
      const objects = [];
      const prefixes = new Set();

      const stream = mc.listObjectsV2(bucketName, prefix, recursive);

      stream.on("data", (item) => {
        if (item.prefix) {
          // Virtual directory
          prefixes.add(item.prefix);
        } else {
          objects.push({
            name: item.name,
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
   * @param {string} bucketName
   * @param {string} objectName
   * @returns {Promise<object>}
   */
  static async statObject(bucketName, objectName) {
    const mc = getClient();
    return mc.statObject(bucketName, objectName);
  }

  /**
   * Get a readable stream for an object.
   * @param {string} bucketName
   * @param {string} objectName
   * @returns {Promise<import('stream').Readable>}
   */
  static async getObject(bucketName, objectName) {
    const mc = getClient();
    return mc.getObject(bucketName, objectName);
  }

  /**
   * Delete an object from a bucket.
   * @param {string} bucketName
   * @param {string} objectName
   * @returns {Promise<void>}
   */
  static async deleteObject(bucketName, objectName) {
    const mc = getClient();
    return mc.removeObject(bucketName, objectName);
  }
}
