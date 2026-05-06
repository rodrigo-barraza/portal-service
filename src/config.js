// ============================================================
// Portal Service — Runtime Configuration
// ============================================================
// Typed accessor layer over process.env. The Vault service is
// the single source of truth — boot.js hydrates process.env
// from the Vault before any module imports run.
//
// This file contains NO defaults and NO secrets.
// ============================================================

export const PORT = process.env.PORTAL_SERVICE_PORT;

export const MONGO_URI = process.env.MONGO_URI;
export const MONGO_DB_NAME = process.env.PORTAL_SERVICE_MONGO_DB_NAME || process.env.MONGO_DB_NAME;

export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT;
export const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
export const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;

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
 * Called once from boot.js after the registry is loaded.
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
