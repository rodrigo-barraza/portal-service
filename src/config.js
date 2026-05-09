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
// Physical machines / hosts that run projects.
// Populated from the registry's `devices` section at boot.
export let DEVICES = {};

/**
 * Infer the project type label from the project ID.
 * Projects ending in "-client" are "Client", "-bot" are "Bot", otherwise "Service".
 */
function inferProjectType(id) {
  if (id.endsWith("-client")) return "Client";
  if (id.endsWith("-bot")) return "Bot";
  return "Service";
}

/**
 * Normalize a GitHub repository URL to HTTPS format.
 * Converts SSH URLs (git@github.com:owner/repo.git) to HTTPS.
 * @param {string|null} repo
 * @returns {string|null}
 */
function normalizeRepoUrl(repo) {
  if (!repo) return null;
  const sshMatch = repo.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`;
  return repo;
}

// ── Registry Hydration ─────────────────────────────────────────
// Populated at boot time by initializeRegistry().
// Until then, PROJECTS and INFRASTRUCTURE are empty objects.
export let PROJECTS = {};
export let INFRASTRUCTURE = {};
export let PROJECT_TYPE_COLORS = {};
export let ANALYTICS_PROPERTIES = [];

/**
 * Build the PROJECTS, INFRASTRUCTURE, and DEVICES maps from the Vault registry.
 * Called once from boot.js after the registry is loaded.
 *
 * @param {{ projects: object[], infrastructure: object[], devices: object[] }} registry
 */
export function initializeRegistry(registry) {
  if (!registry || !registry.projects) {
    console.warn("⚠️  No registry data — PROJECTS and INFRASTRUCTURE will be empty");
    return;
  }

  // ── Projects ─────────────────────────────────────────────────
  const projects = {};

  for (const svc of registry.projects) {
    projects[svc.id] = {
      name: svc.label,
      url: svc.url || "",
      port: svc.port || null,
      healthPath: svc.healthPath || "/",
      environment: "Production",
      visibility: svc.visibility || "internal",
      projectType: inferProjectType(svc.id),
      repo: normalizeRepoUrl(svc.repo),
      device: "synology",
      domain: svc.domain || null,
      dockerProject: svc.dockerProject || null,
      deployTier: svc.deployTier ?? null,
      dependsOn: (svc.dependsOn || []).map((dep) => ({
        id: dep.id,
        criticality: dep.criticality || "required",
      })),
    };
  }

  PROJECTS = projects;

  // ── Analytics Properties ─────────────────────────────────────
  // Derive GA4 properties from project entries that declare an
  // analyticsPropertyId — replaces the old GOOGLE_ANALYTICS_PROPERTIES env var.
  ANALYTICS_PROPERTIES = (registry.projects || [])
    .filter((svc) => svc.analyticsPropertyId)
    .map((svc) => ({
      id: svc.analyticsPropertyId,
      label: svc.label,
      measurementId: svc.analyticsMeasurementId || "",
      serviceId: svc.id,
    }));

  // ── Infrastructure ───────────────────────────────────────────
  const infra = {};

  for (const item of registry.infrastructure || []) {
    infra[item.id] = {
      name: item.label,
      type: item.type,
      projectType: item.type === "database" ? "Database" : "Store",
      url: item.url || "",
      port: item.defaultPort || null,
      environment: "Production",
      visibility: "internal",
      device: "synology",
      domain: item.domain || null,
      deployTier: item.deployTier ?? 0,
      dependsOn: [],
    };
  }

  INFRASTRUCTURE = infra;

  // ── Project Type Colors ─────────────────────────────────────
  PROJECT_TYPE_COLORS = registry.projectTypeColors || {};

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
    `📋 Registry → initialized ${Object.keys(projects).length} projects, ${Object.keys(infra).length} infrastructure, ${Object.keys(devices).length} devices`,
  );
}

// ── LM Studio Instances ────────────────────────────────────────
// These are not in the shared registry (they're local inference
// instances, not deployed projects). If their env vars are set,
// inject them into PROJECTS after registry init.
export function injectLmStudioInstances() {
  const lm1 = process.env.PROVIDER_LM_STUDIO_1_URL;
  const lm2 = process.env.PROVIDER_LM_STUDIO_2_URL;

  if (lm1) {
    PROJECTS["lm-studio"] = {
      name: "LM Studio",
      url: lm1,
      healthPath: "/v1/models",
      environment: "Production",
      visibility: "internal",
      projectType: "Service",
      device: "workstation",
      domain: null,
      dockerProject: null,
      deployTier: 0,
      dependsOn: [],
    };
  }

  if (lm2) {
    PROJECTS["lm-studio-2"] = {
      name: "LM Studio 2",
      url: lm2,
      healthPath: "/v1/models",
      environment: "Production",
      visibility: "internal",
      projectType: "Service",
      device: "workstation2",
      domain: null,
      dockerProject: null,
      deployTier: 0,
      dependsOn: [],
    };
  }
}

// Health check timeout (ms) — how long to wait before marking a service as down
export const HEALTH_CHECK_TIMEOUT_MS = 3000;

// Stats cache TTL (ms) — how long to cache aggregated stats before re-fetching
export const STATS_CACHE_TTL_MS = 30_000;

// ── Google Analytics (GA4 Data API) ───────────────────────────
export const GOOGLE_ANALYTICS_CREDENTIALS = process.env.GOOGLE_ANALYTICS_CREDENTIALS;
// Note: ANALYTICS_PROPERTIES is derived from registry entries (see initializeRegistry above)
