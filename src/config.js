// ============================================================
// Portal Service — Runtime Configuration
// ============================================================
// Imports from secrets.js and provides environment-aware defaults.
// ============================================================

import {
  PORTAL_SERVICE_PORT as SECRETS_PORT,
  MONGO_URI,
  MONGO_DB_NAME,
  PORTAL_CLIENT_URL,
  PORTAL_SERVICE_URL,
  PRISM_SERVICE_URL,
  TOOLS_SERVICE_URL,
  SESSIONS_URL,
  RETINA_CLIENT_URL,
  LIGHTS_SERVICE_URL,
  LUPOS_BOT_URL,
  VAULT_SERVICE_URL,
  ROD_DEV_CLIENT_URL,
  CLOCK_CREW_CLIENT_URL,
  MESSAGES_SERVICE_URL,
  MESSAGES_CLIENT_URL,
  LM_STUDIO_URL,
  LM_STUDIO_2_URL,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
} from "../secrets.js";

export const PORT = SECRETS_PORT || 4001;

export { MONGO_URI, MONGO_DB_NAME };

// ── Dependency Criticality ─────────────────────────────────────
// Shorthand helpers for declaring hard vs. soft dependencies.
//   required — service cannot function without this dependency
//   optional — service degrades gracefully when this is unavailable
const req = (id) => ({ id, criticality: "required" });
const opt = (id) => ({ id, criticality: "optional" });

// ── Devices ────────────────────────────────────────────────────
// Physical machines / hosts that run Sun services.
export const DEVICES = {
  workstation: {
    name: "Workstation",
    type: "Desktop",
    hostname: "192.168.86.99",
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
    hostname: "192.168.86.2",
    os: "DSM 7",
    sshAlias: "nas",
    dockerBin: "/usr/local/bin/docker",
    notes: "Self-hosted production server — runs containerized services.",
  },
};

// ── Upstream Service URLs ──────────────────────────────────────
// API acts as a BFF: aggregates data from all Sun services.
// Each entry includes a `device` key referencing the host it runs on.
export const SERVICES = {
  portal:     { name: "Portal Client",  url: PORTAL_CLIENT_URL,       healthPath: "/",          environment: "Production",   visibility: "internal",  device: "synology",     serviceType: "Client",           repo: "https://github.com/rodrigo-barraza/portal-client",    dependsOn: [req("portalApi")],   dockerProject: "portal-client" },
  portalApi:  { name: "Portal Service", url: PORTAL_SERVICE_URL,   healthPath: "/health",    environment: "Production",   visibility: "internal",  device: "synology",     serviceType: "API",              repo: "https://github.com/rodrigo-barraza/portal-service",    dependsOn: [req("mongodb"), req("vault"), opt("prism"), opt("toolsApi"), opt("sessions"), opt("retina"), opt("lights"), opt("lupos"), opt("rodDev"), opt("minio"), opt("lmStudio"), opt("lmStudio2")],   dockerProject: "portal-service" },
  prism:      { name: "Prism Service",  url: PRISM_SERVICE_URL,        healthPath: "/health",    environment: "Production",   visibility: "external",  device: "synology",     serviceType: "API",              repo: "https://github.com/rodrigo-barraza/prism-service",    hostname: "prism.rod.dev",  dependsOn: [req("mongodb"), req("vault"), opt("toolsApi"), opt("minio"), opt("lmStudio"), opt("lmStudio2")],   dockerProject: "prism-service" },
  toolsApi:   { name: "Tools Service", url: TOOLS_SERVICE_URL,    healthPath: "/health",    environment: "Production",   visibility: "internal",  device: "synology",     serviceType: "API",              repo: "https://github.com/rodrigo-barraza/tools-service", dependsOn: [req("mongodb"), req("vault"), opt("prism")],   dockerProject: "tools-service" },
  sessions:   { name: "Sessions",      url: SESSIONS_URL,     healthPath: "/",          environment: "Development",  visibility: "internal",  device: "workstation",  serviceType: "API",              repo: "https://github.com/rodrigo-barraza/sessions",  dependsOn: [req("mongodb"), req("vault")] },
  retina:     { name: "Retina Client",  url: RETINA_CLIENT_URL,       healthPath: "/",          environment: "Production",   visibility: "external",  device: "synology",     serviceType: "Client",       repo: "https://github.com/rodrigo-barraza/retina-client",    hostname: "retina.rod.dev", dependsOn: [req("prism"), req("sessions"), opt("vault")],   dockerProject: "retina-client" },
  lights:     { name: "Lights Service", url: LIGHTS_SERVICE_URL,       healthPath: "/health",    environment: "Production",   visibility: "internal",  device: "synology",     serviceType: "API",              repo: "https://github.com/rodrigo-barraza/lights-service",    dependsOn: [req("vault"), req("mongodb")],    dockerProject: "lights-service" },
  lmStudio:   { name: "LM Studio",     url: LM_STUDIO_URL,    healthPath: "/v1/models", environment: "Production",  visibility: "internal",  device: "workstation",  serviceType: "API",              dependsOn: [] },
  lmStudio2:  { name: "LM Studio 2",   url: LM_STUDIO_2_URL,  healthPath: "/v1/models", environment: "Production",  visibility: "internal",  device: "workstation2", serviceType: "API",              dependsOn: [] },
  lupos:      { name: "Lupos Bot",      url: LUPOS_BOT_URL,        healthPath: "/health",    environment: "Production",   visibility: "internal",  device: "synology",     serviceType: "Client",      repo: "https://github.com/rodrigo-barraza/lupos-bot",     dependsOn: [req("prism"), req("mongodb"), opt("vault")],   dockerProject: "lupos-bot" },
  vault:      { name: "Vault Service",  url: VAULT_SERVICE_URL,        healthPath: "/health",    environment: "Production",   visibility: "internal",  device: "synology",     serviceType: "API",              repo: "https://github.com/rodrigo-barraza/vault-service",     dependsOn: [],                     dockerProject: "vault-service" },
  rodDev:     { name: "Rod Dev Client", url: ROD_DEV_CLIENT_URL,      healthPath: "/",          environment: "Production",   visibility: "external",  device: "synology",     serviceType: "Client",       repo: "https://github.com/rodrigo-barraza/rod-dev-client",   hostname: "rod.dev",        dependsOn: [req("prism"), req("sessions"), opt("vault")],   dockerProject: "rod-dev-client" },
  clockCrew:  { name: "Clock Crew Client", url: CLOCK_CREW_CLIENT_URL,   healthPath: "/",          environment: "Production",   visibility: "external",  device: "synology",     serviceType: "Client",       repo: "https://github.com/rodrigo-barraza/clock-crew-client", hostname: "clock-crew.com",  dependsOn: [req("vault"), opt("toolsApi")],   dockerProject: "clock-crew-client" },
  messages:   { name: "Messages Service", url: MESSAGES_SERVICE_URL,     healthPath: "/health",    environment: "Production",   visibility: "internal",  device: "synology",     serviceType: "API",              repo: "https://github.com/rodrigo-barraza/messages-service",  dependsOn: [req("mongodb"), req("vault")],   dockerProject: "messages-service" },
  messagesCl: { name: "Messages Client",  url: MESSAGES_CLIENT_URL,     healthPath: "/",          environment: "Production",   visibility: "internal",  device: "synology",     serviceType: "Client",           repo: "https://github.com/rodrigo-barraza/messages-client",   dependsOn: [req("messages")],                dockerProject: "messages-client" },
};

// ── Infrastructure Services ────────────────────────────────────
// Non-HTTP backing services (databases, object stores) hosted on the NAS.
// These require protocol-level checks rather than REST health polling.
export const INFRASTRUCTURE = {
  mongodb: {
    name: "MongoDB",
    type: "database",
    serviceType: "Database",
    url: MONGO_URI || "",
    environment: "Production",
    visibility: "internal",
    device: "synology",
    port: 27017,
    dependsOn: [],
  },
  minio: {
    name: "MinIO",
    type: "object-store",
    serviceType: "Storage",
    url: MINIO_ENDPOINT || "",
    environment: "Production",
    visibility: "internal",
    device: "synology",
    port: 9000,
    dependsOn: [],
  },
};

export { MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY };

// Health check timeout (ms) — how long to wait before marking a service as down
export const HEALTH_CHECK_TIMEOUT_MS = 3000;

// Stats cache TTL (ms) — how long to cache aggregated stats before re-fetching
export const STATS_CACHE_TTL_MS = 30_000;
