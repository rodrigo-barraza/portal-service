// ============================================================
// Portal API — Request Logger Middleware
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

    // Color-code by status range
    const color =
      status >= 500
        ? "\x1b[31m"
        : status >= 400
          ? "\x1b[33m"
          : "\x1b[32m";
    const reset = "\x1b[0m";

    logger.info(
      `${method} ${url} ${color}${status}${reset} ${duration}ms`,
    );
  });

  next();
}
