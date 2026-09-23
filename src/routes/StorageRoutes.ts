// ─── Object Store Route ─────────────────────────────────────

import { Router, type Request, type Response } from "express";
import { initSseResponse, startSseHeartbeat } from "@rodrigo-barraza/utilities-library/express";
import { clamp, getErrorMessage, parseIntParam } from "@rodrigo-barraza/utilities-library";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import MinioService from "../services/MinioService.ts";
import logger from "../utils/logger.ts";
import { queryParam, routeParam, wildcardParam } from "../utils/http.ts";
import {
  assertValidBucketName,
  assertValidObjectName,
  contentDisposition,
  guessMime,
  isScriptableContentType,
  parseRangeHeader,
  toObjectStoreError,
} from "./helpers/ObjectStoreHttp.ts";

const router = Router();

/** Bucket + object key from `/buckets/:name/…/*objectPath`, validated. */
function objectTarget(req: Request): { bucketName: string; objectName: string } {
  const bucketName = routeParam(req, "name");
  const objectName = wildcardParam(req, "objectPath");
  assertValidBucketName(bucketName);
  assertValidObjectName(objectName);
  return { bucketName, objectName };
}

router.get("/search", async (req: Request, res: Response) => {
  const query = queryParam(req, "query")?.trim() ?? "";
  if (!query || query.length > 200) {
    throw new HttpError("Query parameter required (1–200 characters)", 400);
  }

  const bucket = queryParam(req, "bucket");
  if (bucket) assertValidBucketName(bucket);
  const limit = clamp(parseIntParam(queryParam(req, "limit"), 200), 1, 500);

  try {
    res.json(await MinioService.searchObjects(query, { bucket, limit }));
  } catch (error: unknown) {
    throw toObjectStoreError(error);
  }
});

router.get("/buckets", async (_req: Request, res: Response) => {
  const buckets = await MinioService.listBuckets();
  res.json({ buckets });
});

router.get("/buckets/stream", async (_req: Request, res: Response) => {
  // Named `event:` frames — the library emitter only writes data-only
  // frames, so these stay hand-rolled on top of the library headers.
  initSseResponse(res);

  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });
  // A fallback full scan can go quiet for minutes between buckets —
  // comment pings keep proxies from reaping the idle connection.
  const stopHeartbeat = startSseHeartbeat(res);

  try {
    for await (const event of MinioService.streamBuckets()) {
      if (clientGone) break;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.type === "bucket" ? event.bucket : event)}\n\n`);
    }

    if (!clientGone) {
      res.write(`event: done\ndata: {}\n\n`);
    }
  } catch (error: unknown) {
    logger.error(`[ObjectStore] streamBuckets failed: ${getErrorMessage(error)}`);
    if (!clientGone) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: "Failed to list buckets" })}\n\n`);
    }
  } finally {
    stopHeartbeat();
    res.end();
  }
});

router.get("/buckets/:name", async (req: Request, res: Response) => {
  const bucketName = routeParam(req, "name");
  assertValidBucketName(bucketName);
  const prefix = queryParam(req, "prefix") ?? "";
  const recursive = req.query.recursive === "true";

  try {
    const result = await MinioService.listObjects(bucketName, prefix, recursive);
    res.json({ bucket: bucketName, prefix, ...result });
  } catch (error: unknown) {
    throw toObjectStoreError(error);
  }
});

router.get("/buckets/:name/stat/*objectPath", async (req: Request, res: Response) => {
  const { bucketName, objectName } = objectTarget(req);

  try {
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
  } catch (error: unknown) {
    throw toObjectStoreError(error);
  }
});

router.get("/buckets/:name/download/*objectPath", async (req: Request, res: Response) => {
  const { bucketName, objectName } = objectTarget(req);

  let stat;
  try {
    stat = await MinioService.statObject(bucketName, objectName);
  } catch (error: unknown) {
    throw toObjectStoreError(error);
  }

  const contentType = String(stat.metaData?.["content-type"] || guessMime(objectName));
  const filename = objectName.split("/").pop();
  const disposition = req.query.inline === "true" ? "inline" : "attachment";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", contentDisposition(disposition, filename));
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (disposition === "inline" && isScriptableContentType(contentType)) {
    res.setHeader("Content-Security-Policy", "sandbox");
  }
  if (stat.etag) res.setHeader("ETag", `"${stat.etag}"`);
  if (stat.lastModified) res.setHeader("Last-Modified", stat.lastModified.toUTCString());
  res.setHeader("Accept-Ranges", "bytes");

  // Range requests — required for video/audio seeking and Safari playback
  const range = parseRangeHeader(req.headers.range, stat.size);
  if (range.kind === "unsatisfiable") {
    res.setHeader("Content-Range", `bytes */${stat.size}`);
    res.status(416).end();
    return;
  }

  if (range.kind === "range") {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader("Content-Length", range.end - range.start + 1);
  } else {
    res.setHeader("Content-Length", stat.size);
  }

  // HEAD (players probing size/type) needs the headers only.
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const stream =
    range.kind === "range"
      ? await MinioService.getPartialObject(bucketName, objectName, range.start, range.end - range.start + 1)
      : await MinioService.getObject(bucketName, objectName);

  stream.on("error", (streamError: unknown) => {
    logger.error(`[ObjectStore] stream failed mid-transfer: ${getErrorMessage(streamError)}`);
    res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
});

router.delete("/buckets/:name/*objectPath", async (req: Request, res: Response) => {
  const { bucketName, objectName } = objectTarget(req);

  try {
    await MinioService.deleteObject(bucketName, objectName);
  } catch (error: unknown) {
    throw toObjectStoreError(error);
  }
  logger.info(`[ObjectStore] Deleted ${bucketName}/${objectName}`);
  res.json({ success: true, bucket: bucketName, object: objectName });
});

export default router;
