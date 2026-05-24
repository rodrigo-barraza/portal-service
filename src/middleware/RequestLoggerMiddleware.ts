// ─── Request Logger Middleware ──────────────────────────────
// Delegates to @rodrigo-barraza/service-library's standard implementation.
// ─────────────────────────────────────────────────────────────

import { createRequestLoggerMiddleware } from "@rodrigo-barraza/service-library";
import logger from "../utils/logger.ts";

export const requestLoggerMiddleware = createRequestLoggerMiddleware(logger, {
  identityAware: false,
});
