// ============================================================
// Portal API — Runtime Configuration
// ============================================================
// Imports from secrets.js and provides environment-aware defaults.
// ============================================================

import {
  API_PORT as SECRETS_PORT,
  MONGO_URI,
  MONGO_DB_NAME,
  PRISM_URL,
  TOOLS_API_URL,
  SESSIONS_URL,
  RETINA_URL,
  LIGHTS_URL,
  LUPOS_URL,
  LM_STUDIO_URL,
  LM_STUDIO_2_URL,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
} from "../secrets.js";

export const PORT = SECRETS_PORT || 4001;

export { MONGO_URI, MONGO_DB_NAME };

// ── Devices ────────────────────────────────────────────────────────
// Physical machines / hosts that run Sun services.
export const DEVICES = {
  workstation: {
    name: "Workstation",
    type: "Desktop",
    hostname: "localhost",
    os: "Windows 11 (WSL2)",
    notes: "Primary development machine — runs most services locally.",
  },
  workstation2: {
    name: "Workstation 2",
    type: "Desktop",
    hostname: "192.168.86.178",
    os: "Windows 11",
    notes: "Secondary workstation — runs LM Studio for local inference.",
  },
  raspi: {
    name: "Raspberry Pi",
    type: "SBC",
    hostname: "192.168.86.247",
    os: "Raspberry Pi OS",
    notes: "Always-on LAN device — runs Lupos Discord bot.",
  },
  synology: {
    name: "Synology NAS",
    type: "NAS",
    hostname: "216.19.178.138",
    os: "DSM 7",
    notes: "Self-hosted production server — runs containerized services.",
  },
};

// ── Upstream Service URLs ──────────────────────────────────────────
// Portal API acts as a BFF: aggregates data from all Sun services.
// Each entry includes a `device` key referencing the host it runs on.
export const SERVICES = {
  prism:      { name: "Prism",         url: PRISM_URL       || "http://localhost:7777",          healthPath: "/",          stage: "Production",   visibility: "external",  device: "workstation" },
  toolsApi:   { name: "Tools API",     url: TOOLS_API_URL   || "http://localhost:5590",          healthPath: "/health",    stage: "Production",   visibility: "internal",  device: "workstation" },
  sessions:   { name: "Sessions",      url: SESSIONS_URL    || "http://localhost:5557",          healthPath: "/",          stage: "Development",  visibility: "internal",  device: "workstation" },
  retina:     { name: "Retina",        url: RETINA_URL      || "http://localhost:3333",          healthPath: "/",          stage: "Development",  visibility: "external",  device: "workstation" },
  lights:     { name: "Lights",        url: LIGHTS_URL      || "http://localhost:4444",          healthPath: "/",          stage: "Development",  visibility: "internal",  device: "workstation" },
  lmStudio:   { name: "LM Studio",     url: LM_STUDIO_URL   || "http://localhost:1234",          healthPath: "/v1/models", stage: "Production",  visibility: "internal",  device: "workstation" },
  lmStudio2:  { name: "LM Studio 2",   url: LM_STUDIO_2_URL || "http://192.168.86.178:1234",    healthPath: "/v1/models", stage: "Production",  visibility: "internal",  device: "workstation2" },
  lupos:      { name: "Lupos",         url: LUPOS_URL       || "http://192.168.86.247:1337",    healthPath: "/health",    stage: "Production",   visibility: "internal",  device: "raspi" },
  rodDev:     { name: "Rod.dev",       url: "http://216.19.178.138:3000",                        healthPath: "/",          stage: "Production",   visibility: "external",  device: "synology" },
};

// ── Infrastructure Services ────────────────────────────────────────
// Non-HTTP backing services (databases, object stores) hosted on the NAS.
// These require protocol-level checks rather than REST health polling.
export const INFRASTRUCTURE = {
  mongodb: {
    name: "MongoDB",
    type: "database",
    url: MONGO_URI || "",
    stage: "Production",
    visibility: "internal",
    device: "synology",
    port: 27017,
  },
  minio: {
    name: "MinIO",
    type: "object-store",
    url: MINIO_ENDPOINT || "",
    stage: "Production",
    visibility: "internal",
    device: "synology",
    port: 9000,
  },
};

export { MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY };

// Health check timeout (ms) — how long to wait before marking a service as down
export const HEALTH_CHECK_TIMEOUT_MS = 3000;

// Stats cache TTL (ms) — how long to cache aggregated stats before re-fetching
export const STATS_CACHE_TTL_MS = 30_000;
