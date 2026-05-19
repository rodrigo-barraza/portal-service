import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Object Store Route ─────────────────────────────────────

import { Router, Request, Response, NextFunction } from "express";
import MinioService from "../services/MinioService.ts";
import logger from "../utils/logger.ts";
import type { ObjectListResult } from "../types.ts";

const router = Router();

// ── MIME type inference from extension ────────────────────────
const EXT_TO_MIME: Record<string, string> = {
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

function guessMime(filename: string | null | undefined) {
  const ext = (filename || "").match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return (ext && EXT_TO_MIME[ext]) || "application/octet-stream";
}

/**
 * GET /object-store/buckets
 * List all MinIO buckets with object counts and total sizes.
 */
router.get("/buckets", asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const buckets = await MinioService.listBuckets();
    res.json({ buckets });
  } catch (error: any) {
    logger.error(`[ObjectStore] listBuckets failed: ${error.message}`);
    next(error);
  }
}, "Storage_ListBuckets"));

/**
 * GET /object-store/buckets/stream
 * SSE endpoint — streams each bucket as it finishes enrichment.
 * Events:
 *   init   → { totalBuckets: number }
 *   bucket → { name, creationDate, objectCount, totalSize }
 *   done   → {} (signals completion)
 */
router.get("/buckets/stream", asyncHandler(async (req: Request, res: Response) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Flush headers immediately
  res.flushHeaders();

  try {
    for await (const event of MinioService.streamBuckets()) {
      if (req.closed) break;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.type === "bucket" ? event.bucket : event)}\n\n`);
    }

    if (!req.closed) {
      res.write(`event: done\ndata: {}\n\n`);
    }
  } catch (error: any) {
    logger.error(`[ObjectStore] streamBuckets failed: ${error.message}`);
    if (!req.closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
    }
  } finally {
    res.end();
  }
}, "Storage_StreamBuckets"));

/**
 * GET /object-store/buckets/:name
 * List objects in a bucket.
 * Query params:
 *   prefix    — filter by key prefix (default: "")
 *   recursive — if "true", list recursively (default: false)
 */
router.get("/buckets/:name", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const prefix = (req.query.prefix as string) || "";
    const recursive = req.query.recursive === "true";
    const result = await MinioService.listObjects(name, prefix, recursive) as ObjectListResult;
    res.json({ bucket: name, prefix, ...result });
  } catch (error: any) {
    logger.error(`[ObjectStore] listObjects failed: ${error.message}`);
    next(error);
  }
}, "Storage_ListObjects"));

/**
 * GET /object-store/buckets/:name/stat/*objectPath
 * Get metadata (size, content-type, etag, lastModified) for a single object.
 */
router.get("/buckets/:name/stat/*objectPath", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bucketName = req.params.name;
    const objectName = (req.params.objectPath as string) || req.params[0] || "";

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
  } catch (error: any) {
    if (error.code === "NotFound" || error.message?.includes("Not Found")) {
      return res.status(404).json({ error: "Object not found" });
    }
    logger.error(`[ObjectStore] statObject failed: ${error.message}`);
    next(error);
  }
}, "Storage_StatObject"));

/**
 * GET /object-store/buckets/:name/download/*objectPath
 * Stream an object for download or inline viewing.
 * Query params:
 *   inline — if "true", sets Content-Disposition to inline (default: attachment)
 */
router.get("/buckets/:name/download/*objectPath", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bucketName = req.params.name;
    const objectName = (req.params.objectPath as string) || req.params[0] || "";

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
  } catch (error: any) {
    if (error.code === "NotFound" || error.message?.includes("Not Found")) {
      return res.status(404).json({ error: "Object not found" });
    }
    logger.error(`[ObjectStore] getObject failed: ${error.message}`);
    next(error);
  }
}, "Storage_DownloadObject"));

/**
 * DELETE /object-store/buckets/:name/*objectPath
 * Delete a single object from a bucket.
 */
router.delete("/buckets/:name/*objectPath", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bucketName = req.params.name;
    const objectName = (req.params.objectPath as string) || req.params[0] || "";

    if (!objectName) {
      return res.status(400).json({ error: "Object name required" });
    }

    await MinioService.deleteObject(bucketName, objectName);
    logger.info(`[ObjectStore] Deleted ${bucketName}/${objectName}`);
    res.json({ success: true, bucket: bucketName, object: objectName });
  } catch (error: any) {
    logger.error(`[ObjectStore] deleteObject failed: ${error.message}`);
    next(error);
  }
}, "Storage_DeleteObject"));

export default router;
