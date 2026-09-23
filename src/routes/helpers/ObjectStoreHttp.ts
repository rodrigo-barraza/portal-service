// ─── Object Store HTTP Helpers ──────────────────────────────
// Pure request/response helpers for StorageRoutes: name validation,
// MIME inference, Content-Disposition, Range parsing, MinIO errors.

import { HttpError } from "@rodrigo-barraza/utilities-library/service";

// S3 bucket naming rules (MinIO enforces the same set).
const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const MAX_OBJECT_NAME_BYTES = 1024;

/** 400 unless `name` is a well-formed S3 bucket name. */
export function assertValidBucketName(name: string): void {
  if (!BUCKET_NAME_PATTERN.test(name) || name.includes("..")) {
    throw new HttpError(`Invalid bucket name: ${name}`, 400);
  }
}

/**
 * 400 unless `name` is a usable object key. "." / ".." segments are
 * rejected outright — MinIO refuses them anyway, and a key that walks
 * out of its bucket must never reach the S3 request path.
 */
export function assertValidObjectName(name: string): void {
  if (!name) throw new HttpError("Object name required", 400);
  if (Buffer.byteLength(name) > MAX_OBJECT_NAME_BYTES) {
    throw new HttpError("Object name too long", 400);
  }
  if (
    name.includes("\0") ||
    name.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new HttpError("Invalid object name", 400);
  }
}

// ── MIME type inference from extension ────────────────────────
const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".xml": "application/xml",
  ".yml": "application/yaml",
  ".yaml": "application/yaml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
};

export function guessMime(filename: string | null | undefined): string {
  const ext = (filename || "").match(/\.[^./]+$/)?.[0]?.toLowerCase();
  return (ext && EXT_TO_MIME[ext]) || "application/octet-stream";
}

// Types a browser executes script in when navigated to directly. Served
// inline, they get a sandbox CSP so a stored object can't run as this
// origin; <img>/<video> embeds are unaffected.
const SCRIPTABLE_CONTENT_TYPE_PATTERN =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript)\b/i;

export function isScriptableContentType(contentType: string): boolean {
  return SCRIPTABLE_CONTENT_TYPE_PATTERN.test(contentType.trim());
}

/** RFC 5987 attr-char encoding: encodeURIComponent leaves '()* unescaped. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build a Content-Disposition header value that survives quotes,
 * backslashes, CR/LF, and non-ASCII filenames (RFC 6266 + 5987).
 * Raw non-ASCII in setHeader throws; a raw quote or CRLF would break
 * out of the quoted-string.
 */
export function contentDisposition(
  disposition: "inline" | "attachment",
  filename: string | undefined,
): string {
  const name = filename || "download";
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}

export type ByteRange =
  | { kind: "none" } // no usable Range header — serve the whole object
  | { kind: "unsatisfiable" } // 416
  | { kind: "range"; start: number; end: number };

/**
 * Parse a `Range: bytes=…` header against a known size. Only a single
 * range is supported; anything else (multi-range, other units, junk) is
 * ignored per RFC 9110 §14.2 and the full object is served.
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  size: number,
): ByteRange {
  if (!rangeHeader) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) return { kind: "none" };

  let start: number;
  let end: number;
  if (match[1] === "") {
    // Suffix range: last N bytes
    const suffixLength = Number.parseInt(match[2], 10);
    if (suffixLength === 0) return { kind: "unsatisfiable" };
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end =
      match[2] === ""
        ? size - 1
        : Math.min(Number.parseInt(match[2], 10), size - 1);
  }

  if (start > end || start >= size) return { kind: "unsatisfiable" };
  return { kind: "range", start, end };
}

// minio-js error codes/names → client-facing failures. NotFound is
// statObject's code for a missing key (a HEAD response carries no S3
// error body, so there is no NoSuchKey to read).
const MINIO_CLIENT_ERRORS: Record<
  string,
  { status: number; message: string | null }
> = {
  NoSuchBucket: { status: 404, message: "Bucket not found" },
  NoSuchKey: { status: 404, message: "Object not found" },
  NotFound: { status: 404, message: "Object not found" },
  InvalidBucketNameError: { status: 400, message: null },
  InvalidObjectNameError: { status: 400, message: null },
  InvalidPrefixError: { status: 400, message: null },
  XMinioInvalidObjectName: { status: 400, message: null },
};

/**
 * Map a MinIO client error onto an HttpError when it is the caller's
 * fault (missing bucket/key, malformed name); otherwise return the
 * original error untouched (→ generic 500).
 */
export function toObjectStoreError(error: unknown): unknown {
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const message =
    typeof candidate?.message === "string" ? candidate.message : "";
  const known = MINIO_CLIENT_ERRORS[code] ?? MINIO_CLIENT_ERRORS[name];
  if (known)
    return new HttpError(
      known.message ?? (message || "Invalid request"),
      known.status,
    );
  if (message.includes("Not Found"))
    return new HttpError("Object not found", 404);
  return error;
}
