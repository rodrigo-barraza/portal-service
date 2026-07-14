// ─── Request Logger Middleware ──────────────────────────────
// Delegates to @rodrigo-barraza/utilities-library/service's standard implementation.
// ─────────────────────────────────────────────────────────────

import { createRequestLoggerMiddleware } from "@rodrigo-barraza/utilities-library/service";
import logger from "../utils/logger.ts";

export const requestLoggerMiddleware = createRequestLoggerMiddleware(logger, {
  identityAware: false,
});
