// ─── Request Logger Middleware ──────────────────────────────

import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger.ts";

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const method = req.method;
    const url = req.originalUrl;

    const time = duration >= 1000
      ? `${(duration / 1000).toFixed(2)}s`
      : `${duration}ms`;

    logger.request(method, url, status, time);
  });

  next();
}
