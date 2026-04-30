// ============================================================
// API — Request Logger Middleware
// ============================================================
// Logs each incoming request with timing metadata.
// ============================================================

import logger from "../utils/logger.js";

export function requestLoggerMiddleware(req, res, next) {
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
