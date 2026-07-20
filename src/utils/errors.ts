// ─── Express Error Handler ──────────────────────────────────

import { type Request, type Response, type NextFunction } from "express";
import logger from "./logger.ts";

export function errorHandler(error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) {
  logger.error(`Unhandled error: ${error.message}`);
  if (error.stack) logger.error(error.stack);

  res.status(error.status || 500).json({
    error: true,
    message: error.message || "Internal server error",
  });
}
