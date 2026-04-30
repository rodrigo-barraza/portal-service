// ─────────────────────────────────────────────────────────────
// Re-export shared logger, scoped to this service.
// ─────────────────────────────────────────────────────────────

import { createLogger } from "@rodrigo-barraza/utilities/node";

const logger = createLogger("portal");

export default logger;
