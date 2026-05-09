// ============================================================
// API Portal — Object Store Route
// ============================================================
// GET  /object-store/buckets                          — list all buckets
// GET  /object-store/buckets/:name                    — list objects in a bucket
// GET  /object-store/buckets/:name/stat/*objectPath    — stat a single object
// GET  /object-store/buckets/:name/download/*objectPath — stream/download an object
// DELETE /object-store/buckets/:name/*objectPath       — delete an object
// ============================================================

import { Router } from "express";
import MinioService from "../services/MinioService.js";
import logger from "../utils/logger.js";

const router = Router();

// ── MIME type inference from extension ────────────────────────
const EXT_TO_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
};

function guessMime(filename) {
  const ext = (filename || "").match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return EXT_TO_MIME[ext] || "application/octet-stream";
}

/**
 * GET /object-store/buckets
 * List all MinIO buckets with object counts and total sizes.
 */
router.get("/buckets", async (_req, res, next) => {
  try {
    const buckets = await MinioService.listBuckets();
    res.json({ buckets });
  } catch (err) {
    logger.error(`[ObjectStore] listBuckets failed: ${err.message}`);
    next(err);
  }
});

/**
 * GET /object-store/buckets/:name
 * List objects in a bucket.
 * Query params:
 *   prefix    — filter by key prefix (default: "")
 *   recursive — if "true", list recursively (default: false)
 */
router.get("/buckets/:name", async (req, res, next) => {
  try {
    const { name } = req.params;
    const prefix = req.query.prefix || "";
    const recursive = req.query.recursive === "true";
    const result = await MinioService.listObjects(name, prefix, recursive);
    res.json({ bucket: name, prefix, ...result });
  } catch (err) {
    logger.error(`[ObjectStore] listObjects failed: ${err.message}`);
    next(err);
  }
});

/**
 * GET /object-store/buckets/:name/stat/*objectPath
 * Get metadata (size, content-type, etag, lastModified) for a single object.
 */
router.get("/buckets/:name/stat/*objectPath", async (req, res, next) => {
  try {
    const bucketName = req.params.name;
    const objectName = [].concat(req.params.objectPath).join("/");

    if (!objectName) {
      return res.status(400).json({ error: "Object name required" });
    }

    const stat = await MinioService.statObject(bucketName, objectName);
    res.json({
      bucket: bucketName,
      object: objectName,
      size: stat.size,
      contentType: stat.metaData?.["content-type"] || guessMime(objectName),
      etag: stat.etag,
      lastModified: stat.lastModified?.toISOString() || null,
      metadata: stat.metaData || {},
    });
  } catch (err) {
    if (err.code === "NotFound" || err.message?.includes("Not Found")) {
      return res.status(404).json({ error: "Object not found" });
    }
    logger.error(`[ObjectStore] statObject failed: ${err.message}`);
    next(err);
  }
});

/**
 * GET /object-store/buckets/:name/download/*objectPath
 * Stream an object for download or inline viewing.
 * Query params:
 *   inline — if "true", sets Content-Disposition to inline (default: attachment)
 */
router.get("/buckets/:name/download/*objectPath", async (req, res, next) => {
  try {
    const bucketName = req.params.name;
    const objectName = [].concat(req.params.objectPath).join("/");

    if (!objectName) {
      return res.status(400).json({ error: "Object name required" });
    }

    // Get stat for content-type & size
    const stat = await MinioService.statObject(bucketName, objectName);
    const contentType = stat.metaData?.["content-type"] || guessMime(objectName);
    const filename = objectName.split("/").pop();
    const disposition = req.query.inline === "true" ? "inline" : "attachment";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);
    res.setHeader("ETag", stat.etag);

    const stream = await MinioService.getObject(bucketName, objectName);
    stream.pipe(res);
  } catch (err) {
    if (err.code === "NotFound" || err.message?.includes("Not Found")) {
      return res.status(404).json({ error: "Object not found" });
    }
    logger.error(`[ObjectStore] getObject failed: ${err.message}`);
    next(err);
  }
});

/**
 * DELETE /object-store/buckets/:name/*objectPath
 * Delete a single object from a bucket.
 */
router.delete("/buckets/:name/*objectPath", async (req, res, next) => {
  try {
    const bucketName = req.params.name;
    const objectName = [].concat(req.params.objectPath).join("/");

    if (!objectName) {
      return res.status(400).json({ error: "Object name required" });
    }

    await MinioService.deleteObject(bucketName, objectName);
    logger.info(`[ObjectStore] Deleted ${bucketName}/${objectName}`);
    res.json({ success: true, bucket: bucketName, object: objectName });
  } catch (err) {
    logger.error(`[ObjectStore] deleteObject failed: ${err.message}`);
    next(err);
  }
});

export default router;
