// ============================================================
// API — Express Error Handler
// ============================================================

import logger from "./logger.js";

export function errorHandler(err, _req, res, _next) {
  logger.error(`Unhandled error: ${err.message}`);
  if (err.stack) logger.error(err.stack);

  res.status(err.status || 500).json({
    error: true,
    message: err.message || "Internal server error",
  });
}
