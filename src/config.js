// ============================================================
// Portal Service — Runtime Configuration
// ============================================================
// Builds SERVICES and INFRASTRUCTURE from the Vault registry
// (single source of truth), overlaid with portal-specific
// operational metadata (devices, hostnames, visibility).
//
// The registry supplies:  ports, URLs, dependency graphs,
//                         types, deploy tiers, docker projects.
// This file supplies:     device assignments, public hostnames,
//                         environment labels, visibility.
// ============================================================

import {
  PORTAL_SERVICE_PORT as SECRETS_PORT,
  MONGO_URI,
  MONGO_DB_NAME,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
} from "../secrets.js";

export const PORT = SECRETS_PORT || 4001;

export { MONGO_URI, MONGO_DB_NAME, MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY };

// ── Devices ────────────────────────────────────────────────────
// Physical machines / hosts that run Sun services.
// This is portal-specific operational topology — NOT stored in
// the shared registry (which is deployment-agnostic).
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

// ── Portal-Specific Overlays ───────────────────────────────────
// Operational metadata that the shared registry doesn't carry.
// Keyed by the canonical service ID from services.json.
const SERVICE_OVERLAYS = {
  "portal-client":       { device: "synology",     environment: "Production",  visibility: "internal" },
  "portal-service":      { device: "synology",     environment: "Production",  visibility: "internal" },
  "prism-service":       { device: "synology",     environment: "Production",  visibility: "external",  hostname: "prism.rod.dev" },
  "tools-service":       { device: "synology",     environment: "Production",  visibility: "internal" },
  "retina-client":       { device: "synology",     environment: "Production",  visibility: "external",  hostname: "retina.rod.dev" },
  "lights-service":      { device: "synology",     environment: "Production",  visibility: "internal" },
  "lights-client":       { device: "synology",     environment: "Production",  visibility: "internal" },
  "clock-crew-service":  { device: "synology",     environment: "Production",  visibility: "internal" },
  "clock-crew-client":   { device: "synology",     environment: "Production",  visibility: "external",  hostname: "clock-crew.com" },
  "messages-service":    { device: "synology",     environment: "Production",  visibility: "internal" },
  "messages-client":     { device: "synology",     environment: "Production",  visibility: "internal" },
  "vault-service":       { device: "synology",     environment: "Production",  visibility: "internal" },
  "rod-dev-client":      { device: "synology",     environment: "Production",  visibility: "external",  hostname: "rod.dev" },
  "lupos-bot":           { device: "synology",     environment: "Production",  visibility: "internal" },
  "lm-studio":           { device: "workstation",  environment: "Production",  visibility: "internal" },
  "lm-studio-2":         { device: "workstation2", environment: "Production",  visibility: "internal" },
};

// Map registry type → portal's serviceType label
const TYPE_MAP = {
  service: "API",
  gateway: "API",
  client:  "Client",
  bot:     "Client",
  infra:   "API",
};

// ── Registry Hydration ─────────────────────────────────────────
// Populated at boot time by initializeRegistry().
// Until then, SERVICES and INFRASTRUCTURE are empty objects.
export let SERVICES = {};
export let INFRASTRUCTURE = {};

/**
 * Build the SERVICES and INFRASTRUCTURE maps from the Vault registry.
 * Called once from boot.js after secrets + registry are loaded.
 *
 * @param {{ services: object[], infrastructure: object[] }} registry
 */
export function initializeRegistry(registry) {
  if (!registry || !registry.services) {
    console.warn("⚠️  No registry data — SERVICES and INFRASTRUCTURE will be empty");
    return;
  }

  // ── Services ─────────────────────────────────────────────────
  const services = {};

  for (const svc of registry.services) {
    const overlay = SERVICE_OVERLAYS[svc.id] || {};

    services[svc.id] = {
      name: svc.label,
      url: svc.url || "",
      healthPath: svc.healthPath || "/",
      environment: overlay.environment || "Production",
      visibility: overlay.visibility || "internal",
      serviceType: TYPE_MAP[svc.type] || "API",
      repo: svc.repo ? `https://github.com/rodrigo-barraza/${svc.repo}` : null,
      device: overlay.device || null,
      hostname: overlay.hostname || null,
      dockerProject: svc.dockerProject || null,
      dependsOn: (svc.dependsOn || []).map((dep) => ({
        id: dep.id,
        criticality: dep.criticality || "required",
      })),
    };
  }

  SERVICES = services;

  // ── Infrastructure ───────────────────────────────────────────
  const infra = {};

  for (const item of registry.infrastructure || []) {
    infra[item.id] = {
      name: item.label,
      type: item.type,
      serviceType: item.type === "database" ? "Database" : "Storage",
      url: item.url || "",
      port: item.defaultPort || null,
      environment: "Production",
      visibility: "internal",
      device: "synology",
      dependsOn: [],
    };
  }

  INFRASTRUCTURE = infra;

  console.warn(
    `📋 Registry → initialized ${Object.keys(services).length} services, ${Object.keys(infra).length} infrastructure`,
  );
}

// ── LM Studio Instances ────────────────────────────────────────
// These are not in the shared registry (they're local inference
// instances, not deployed services). If their env vars are set,
// inject them into SERVICES after registry init.
export function injectLmStudioInstances() {
  const lm1 = process.env.LM_STUDIO_URL;
  const lm2 = process.env.LM_STUDIO_2_URL;

  if (lm1) {
    SERVICES["lm-studio"] = {
      name: "LM Studio",
      url: lm1,
      healthPath: "/v1/models",
      environment: "Production",
      visibility: "internal",
      serviceType: "API",
      device: "workstation",
      hostname: null,
      dockerProject: null,
      dependsOn: [],
    };
  }

  if (lm2) {
    SERVICES["lm-studio-2"] = {
      name: "LM Studio 2",
      url: lm2,
      healthPath: "/v1/models",
      environment: "Production",
      visibility: "internal",
      serviceType: "API",
      device: "workstation2",
      hostname: null,
      dockerProject: null,
      dependsOn: [],
    };
  }
}

// Health check timeout (ms) — how long to wait before marking a service as down
export const HEALTH_CHECK_TIMEOUT_MS = 3000;

// Stats cache TTL (ms) — how long to cache aggregated stats before re-fetching
export const STATS_CACHE_TTL_MS = 30_000;
