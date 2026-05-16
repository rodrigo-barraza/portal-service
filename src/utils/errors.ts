// ─── Express Error Handler ──────────────────────────────────

import { Request, Response, NextFunction } from "express";
import logger from "./logger.js";

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  logger.error(`Unhandled error: ${err.message}`);
  if (err.stack) logger.error(err.stack);

  res.status(err.status || 500).json({
    error: true,
    message: err.message || "Internal server error",
  });
}
