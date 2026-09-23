// ─── Express Error Handler ──────────────────────────────────
// Routes are plain async handlers — Express 5 forwards a rejected
// promise here, so no route needs its own try/catch → next(error).
// Throw `new HttpError(message, status)` (utilities-library/service)
// for a deliberate, client-facing failure; anything else is an
// unexpected error whose text stays in the log.
//
// Envelope: `{ error: "<message>" }` — the same shape routes send
// explicitly, and the field both consumers read (components-library's
// and utilities-library's API clients throw `new Error(body.error)`, so
// the old `{ error: true, message }` surfaced as the text "true").

import { type Request, type Response, type NextFunction } from "express";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import logger from "./logger.ts";

const GENERIC_SERVER_ERROR_MESSAGE = "Internal server error";

/** The HTTP status an error carries (`statusCode` or `status`), else 500. */
export function resolveErrorStatus(error: unknown): number {
  const candidate = error as { statusCode?: unknown; status?: unknown } | null;
  const raw = candidate?.statusCode ?? candidate?.status;
  return typeof raw === "number" && raw >= 400 && raw <= 599 ? raw : 500;
}

export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction) {
  const status = resolveErrorStatus(error);
  const message = getErrorMessage(error);

  if (status >= 500) {
    logger.error(`Unhandled error: ${message}`);
    if (error instanceof Error && error.stack) logger.error(error.stack);
  }

  // A streaming response (SSE, object download) that fails mid-body can't
  // switch to a JSON error — Express's default handler aborts the socket.
  if (res.headersSent) {
    next(error);
    return;
  }

  // 4xx text is always meant for the caller; 5xx text only when the route
  // raised it on purpose. A driver/socket error message (hostnames, paths,
  // query fragments) never leaves the process — this API is public.
  const exposeMessage = status < 500 || error instanceof HttpError;
  res.status(status).json({
    error: exposeMessage && message ? message : GENERIC_SERVER_ERROR_MESSAGE,
  });
}

/** JSON 404 for unmatched routes, in the same envelope (Express's default is an HTML page). */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
}
