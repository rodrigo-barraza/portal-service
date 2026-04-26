// ============================================================
// Portal API — Runtime Configuration
// ============================================================
// Imports from secrets.js and provides environment-aware defaults.
// ============================================================

import {
  PORT as SECRETS_PORT,
  MONGO_URI,
  MONGO_DB_NAME,
  PRISM_URL,
  TOOLS_API_URL,
  SESSIONS_URL,
  RETINA_URL,
  LIGHTS_URL,
  LUPOS_URL,
} from "../secrets.js";

export const PORT = SECRETS_PORT || 4001;

export { MONGO_URI, MONGO_DB_NAME };

// ── Upstream Service URLs ──────────────────────────────────────────
// Portal API acts as a BFF: aggregates data from all Sun services.
export const SERVICES = {
  prism: { name: "Prism", url: PRISM_URL || "http://localhost:7777", healthPath: "/" },
  toolsApi: { name: "Tools API", url: TOOLS_API_URL || "http://localhost:5590", healthPath: "/health" },
  sessions: { name: "Sessions", url: SESSIONS_URL || "http://localhost:5557", healthPath: "/" },
  retina: { name: "Retina", url: RETINA_URL || "http://localhost:3333", healthPath: "/" },
  lights: { name: "Lights", url: LIGHTS_URL || "http://localhost:4444", healthPath: "/" },
  lupos: { name: "Lupos", url: LUPOS_URL || "http://192.168.86.247:1337", healthPath: "/health" },
  rodDev: { name: "Rod.dev", url: "http://216.19.178.138:3000", healthPath: "/" },
};

// Health check timeout (ms) — how long to wait before marking a service as down
export const HEALTH_CHECK_TIMEOUT_MS = 3000;

// Stats cache TTL (ms) — how long to cache aggregated stats before re-fetching
export const STATS_CACHE_TTL_MS = 30_000;
