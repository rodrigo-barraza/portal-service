import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// ─── Object Store Route ─────────────────────────────────────

import { Router, Request, Response, NextFunction } from "express";
import MinioService from "../services/MinioService.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import type { ObjectListResult } from "../types.ts";

const router = Router();

router.get("/search", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
    if (!query || query.length > 200) {
      return res.status(400).json({ error: "Query parameter required (1–200 characters)" });
    }

    const bucket = typeof req.query.bucket === "string" ? req.query.bucket : undefined;
    const rawLimit = parseInt(String(req.query.limit || "200"), 10);
    const limit = Math.min(Math.max(rawLimit, 1), 500);

    const searchResult = await MinioService.searchObjects(query, { bucket, limit });
    res.json(searchResult);
  } catch (error: unknown) {
    logger.error(`[ObjectStore] search failed: ${getErrorMessage(error)}`);
    next(error);
  }
}, "Storage_Search"));

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

router.get("/buckets", asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const buckets = await MinioService.listBuckets();
    res.json({ buckets });
  } catch (error: unknown) {
    logger.error(`[ObjectStore] listBuckets failed: ${getErrorMessage(error)}`);
    next(error);
  }
}, "Storage_ListBuckets"));

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
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    logger.error(`[ObjectStore] streamBuckets failed: ${message}`);
    if (!req.closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    }
  } finally {
    res.end();
  }
}, "Storage_StreamBuckets"));

router.get("/buckets/:name", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.params;
    const prefix = typeof req.query.prefix === "string" ? req.query.prefix : "";
    const recursive = req.query.recursive === "true";
    const result = await MinioService.listObjects(String(name), prefix, recursive) as ObjectListResult;
    res.json({ bucket: name, prefix, ...result });
  } catch (error: unknown) {
    logger.error(`[ObjectStore] listObjects failed: ${getErrorMessage(error)}`);
    next(error);
  }
}, "Storage_ListObjects"));

router.get("/buckets/:name/stat/*objectPath", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bucketName = req.params.name;
    const objectName = String(req.params.objectPath || req.params[0] || "");

    if (!objectName) {
      return res.status(400).json({ error: "Object name required" });
    }

    const stat = await MinioService.statObject(String(bucketName), objectName);
    res.json({
      bucket: bucketName,
      object: objectName,
      size: stat.size,
      contentType: stat.metaData?.["content-type"] || guessMime(objectName),
      etag: stat.etag,
      lastModified: stat.lastModified?.toISOString() || null,
      metadata: stat.metaData || {},
    });
  } catch (error: unknown) {
    const errorObject = error as Record<string, unknown>;
    const code = String(errorObject.code || "");
    const message = getErrorMessage(error);
    if (code === "NotFound" || message.includes("Not Found")) {
      return res.status(404).json({ error: "Object not found" });
    }
    logger.error(`[ObjectStore] statObject failed: ${message}`);
    next(error);
  }
}, "Storage_StatObject"));

router.get("/buckets/:name/download/*objectPath", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bucketName = req.params.name;
    const objectName = String(req.params.objectPath || req.params[0] || "");

    if (!objectName) {
      return res.status(400).json({ error: "Object name required" });
    }

    // Get stat for content-type & size
    const stat = await MinioService.statObject(String(bucketName), objectName);
    const contentType = stat.metaData?.["content-type"] || guessMime(objectName);
    const filename = objectName.split("/").pop();
    const disposition = req.query.inline === "true" ? "inline" : "attachment";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);
    res.setHeader("ETag", stat.etag);

    const stream = await MinioService.getObject(String(bucketName), objectName);
    stream.pipe(res);
  } catch (error: unknown) {
    const errorObject = error as Record<string, unknown>;
    const code = String(errorObject.code || "");
    const message = getErrorMessage(error);
    if (code === "NotFound" || message.includes("Not Found")) {
      return res.status(404).json({ error: "Object not found" });
    }
    logger.error(`[ObjectStore] getObject failed: ${message}`);
    next(error);
  }
}, "Storage_DownloadObject"));

router.delete("/buckets/:name/*objectPath", asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bucketName = req.params.name;
    const objectName = String(req.params.objectPath || req.params[0] || "");

    if (!objectName) {
      return res.status(400).json({ error: "Object name required" });
    }

    await MinioService.deleteObject(String(bucketName), objectName);
    logger.info(`[ObjectStore] Deleted ${bucketName}/${objectName}`);
    res.json({ success: true, bucket: bucketName, object: objectName });
  } catch (error: unknown) {
    logger.error(`[ObjectStore] deleteObject failed: ${getErrorMessage(error)}`);
    next(error);
  }
}, "Storage_DeleteObject"));

export default router;
