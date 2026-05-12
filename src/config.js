// ─── Runtime Configuration ──────────────────────────────────

import logger from "./utils/logger.js";

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
 * If the registry entry carries an explicit `projectType`, use it directly.
 * Otherwise: projects ending in "-client" are "Client", "-bot" are "Bot",
 * entries without repo/docker are "Infrastructure", rest are "Service".
 */
function inferProjectType(id, svc) {
  if (svc.projectType) return svc.projectType;
  if (!svc.repo && !svc.dockerProject) return "Infrastructure";
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
export let DEPLOY_TIER_COLORS = {};
export let ANALYTICS_PROPERTIES = [];

/**
 * Build the PROJECTS, INFRASTRUCTURE, and DEVICES maps from the Vault registry.
 * Called once from boot.js after the registry is loaded.
 *
 * @param {{ projects: object[], infrastructure: object[], devices: object[] }} registry
 */
export function initializeRegistry(registry) {
  if (!registry || !registry.projects) {
    logger.warn("No registry data — PROJECTS and INFRASTRUCTURE will be empty");
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
      projectType: inferProjectType(svc.id, svc),
      description: svc.description || null,
      db: svc.db || null,
      minioBucket: svc.minioBucket || null,
      repo: normalizeRepoUrl(svc.repo),
      npmPackage: svc.npmPackage || null,
      device: svc.device || "synology",
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

  const infraTypeLabels = { database: "Database", "object-store": "Store", inference: "Inference" };

  for (const item of registry.infrastructure || []) {
    infra[item.id] = {
      name: item.label,
      type: item.type,
      projectType: infraTypeLabels[item.type] || "Infrastructure",
      url: item.url || "",
      port: item.defaultPort || null,
      healthPath: item.healthPath || null,
      environment: "Production",
      visibility: "internal",
      device: item.device || "synology",
      domain: item.domain || null,
      deployTier: item.deployTier ?? 0,
      dependsOn: [],
    };
  }

  INFRASTRUCTURE = infra;

  // ── Project Type Colors ─────────────────────────────────────
  PROJECT_TYPE_COLORS = registry.projectTypeColors || {};

  // ── Deploy Tier Colors ──────────────────────────────────────
  DEPLOY_TIER_COLORS = registry.deployTierColors || {};

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
      dockerApi: dev.dockerApi || null,
      notes: dev.notes || "",
      specs: dev.specs || null,
    };
  }

  DEVICES = devices;

  logger.warn(
    `Registry → initialized ${Object.keys(projects).length} projects, ${Object.keys(infra).length} infrastructure, ${Object.keys(devices).length} devices`,
  );
}

// Health check timeout (ms) — how long to wait before marking a service as down
export const HEALTH_CHECK_TIMEOUT_MS = 3000;

// Stats cache TTL (ms) — how long to cache aggregated stats before re-fetching
export const STATS_CACHE_TTL_MS = 30_000;

// ── Google Analytics (GA4 Data API) ───────────────────────────
export const GOOGLE_ANALYTICS_CREDENTIALS = process.env.GOOGLE_ANALYTICS_CREDENTIALS;
// Note: ANALYTICS_PROPERTIES is derived from registry entries (see initializeRegistry above)
