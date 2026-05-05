// ============================================================
// Portal Service — Runtime Configuration
// ============================================================
// Builds SERVICES and INFRASTRUCTURE from the Vault registry
// (single source of truth). The registry supplies all metadata:
// ports, URLs, dependency graphs, deploy tiers, hostnames,
// visibility, and docker projects.
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
// Physical machines / hosts that run services.
// Populated from the registry's `devices` section at boot.
export let DEVICES = {};

/**
 * Infer the portal service type label from the service ID.
 * Services ending in "-client" are "Client", "-bot" are "Bot", otherwise "Service".
 */
function inferServiceType(id) {
  if (id.endsWith("-client")) return "Client";
  if (id.endsWith("-bot")) return "Bot";
  return "Service";
}

// ── Registry Hydration ─────────────────────────────────────────
// Populated at boot time by initializeRegistry().
// Until then, SERVICES and INFRASTRUCTURE are empty objects.
export let SERVICES = {};
export let INFRASTRUCTURE = {};
export let SERVICE_TYPE_COLORS = {};

/**
 * Build the SERVICES, INFRASTRUCTURE, and DEVICES maps from the Vault registry.
 * Called once from boot.js after secrets + registry are loaded.
 *
 * @param {{ services: object[], infrastructure: object[], devices: object[] }} registry
 */
export function initializeRegistry(registry) {
  if (!registry || !registry.services) {
    console.warn("⚠️  No registry data — SERVICES and INFRASTRUCTURE will be empty");
    return;
  }

  // ── Services ─────────────────────────────────────────────────
  const services = {};

  for (const svc of registry.services) {
    services[svc.id] = {
      name: svc.label,
      url: svc.url || "",
      port: svc.port || null,
      healthPath: svc.healthPath || "/",
      environment: "Production",
      visibility: svc.visibility || "internal",
      serviceType: inferServiceType(svc.id),
      repo: svc.repo || null,
      device: "synology",
      domain: svc.domain || null,
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
      serviceType: item.type === "database" ? "Database" : "Store",
      url: item.url || "",
      port: item.defaultPort || null,
      environment: "Production",
      visibility: "internal",
      device: "synology",
      dependsOn: [],
    };
  }

  INFRASTRUCTURE = infra;

  // ── Service Type Colors ─────────────────────────────────────
  SERVICE_TYPE_COLORS = registry.serviceTypeColors || {};

  // ── Devices ─────────────────────────────────────────────────
  const devices = {};

  for (const dev of registry.devices || []) {
    devices[dev.id] = {
      name: dev.label,
      type: dev.type,
      hostname: dev.hostname || "",
      os: dev.os || "",
      sshAlias: dev.sshAlias || null,
      dockerBin: dev.dockerBin || null,
      notes: dev.notes || "",
    };
  }

  DEVICES = devices;

  console.warn(
    `📋 Registry → initialized ${Object.keys(services).length} services, ${Object.keys(infra).length} infrastructure, ${Object.keys(devices).length} devices`,
  );
}

// ── LM Studio Instances ────────────────────────────────────────
// These are not in the shared registry (they're local inference
// instances, not deployed services). If their env vars are set,
// inject them into SERVICES after registry init.
export function injectLmStudioInstances() {
  const lm1 = process.env.PROVIDER_LM_STUDIO_1_URL;
  const lm2 = process.env.PROVIDER_LM_STUDIO_2_URL;

  if (lm1) {
    SERVICES["lm-studio"] = {
      name: "LM Studio",
      url: lm1,
      healthPath: "/v1/models",
      environment: "Production",
      visibility: "internal",
      serviceType: "Service",
      device: "workstation",
      domain: null,
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
      serviceType: "Service",
      device: "workstation2",
      domain: null,
      dockerProject: null,
      dependsOn: [],
    };
  }
}

// Health check timeout (ms) — how long to wait before marking a service as down
export const HEALTH_CHECK_TIMEOUT_MS = 3000;

// Stats cache TTL (ms) — how long to cache aggregated stats before re-fetching
export const STATS_CACHE_TTL_MS = 30_000;
