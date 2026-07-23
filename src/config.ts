// ─── Runtime Configuration ──────────────────────────────────

import logger from "./utils/logger.ts";
import type { ProjectEntry, InfrastructureEntry, DeviceEntry, AnalyticsProperty, VaultRegistry, VaultRegistryProject } from "./types.ts";

export const PORT = process.env.PORTAL_SERVICE_PORT;

export const MONGO_URI = process.env.MONGO_URI;
export const MONGO_DB_NAME = process.env.PORTAL_SERVICE_MONGO_DB_NAME || process.env.MONGO_DB_NAME;

// Read-only cross-service databases for the External APIs dashboard:
// prism's `requests` collection (LLM usage) and tools-service's
// `external-api-usage` buckets live on the same Mongo server.
export const PRISM_MONGO_DB_NAME = process.env.PRISM_SERVICE_MONGO_DB_NAME || "prism";
export const TOOLS_MONGO_DB_NAME = process.env.TOOLS_SERVICE_MONGO_DB_NAME || "tools";

export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT;
export const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
export const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;

export const GITHUB_PAT = process.env.GITHUB_PAT || "";

// In Docker, points Playwright at system Chromium (see Dockerfile);
// unset locally so Playwright uses its own downloaded browser.
export const PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "";

// ── Devices ────────────────────────────────────────────────────
// Physical machines / hosts that run projects.
// Populated from the registry's `devices` section at boot.
export let DEVICES: Record<string, DeviceEntry> = {};

function inferProjectType(id: string, service: VaultRegistryProject) {
  if (service.projectType) return service.projectType;
  if (!service.repo && !service.dockerProject) return "Infrastructure";
  if (id.endsWith("-client")) return "Client";
  if (id.endsWith("-bot")) return "Bot";
  return "Service";
}

function inferDeployTier(projectType: string) {
  switch (projectType) {
    case "Infrastructure": return 0;
    case "Service":        return 1;
    case "Client":         return 1;
    default:               return 2; // Bot, Library, Kit, Tool
  }
}

// Build a project's dependency list: hand-declared registry edges first,
// then edges derived from structured registry fields (db → mongodb,
// minioBucket → minio) so infrastructure connections never need to be
// hand-listed. Derived edges are deduped against declared ones.
function deriveDependencies(service: VaultRegistryProject) {
  const dependencies = (service.dependsOn || []).map((dep) => ({
    id: dep.id,
    criticality: dep.criticality || "required",
    source: "registry",
  }));

  const derived: Array<{ id: string; criticality: string; source: string }> = [];
  if (service.db) derived.push({ id: "mongodb", criticality: "required", source: "derived" });
  const hasMinioBucket = Array.isArray(service.minioBucket)
    ? service.minioBucket.length > 0
    : Boolean(service.minioBucket);
  if (hasMinioBucket) derived.push({ id: "minio", criticality: "required", source: "derived" });

  const declaredIds = new Set(dependencies.map((dep) => dep.id));
  for (const dep of derived) {
    if (!declaredIds.has(dep.id)) dependencies.push(dep);
  }

  return dependencies;
}

function normalizeRepoUrl(repo: string | null) {
  if (!repo) return null;
  const sshMatch = repo.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`;
  return repo;
}

// ── Registry Hydration ─────────────────────────────────────────
// Populated at boot time by initializeRegistry().
// Until then, PROJECTS and INFRASTRUCTURE are empty objects.
export let PROJECTS: Record<string, ProjectEntry> = {};
export let INFRASTRUCTURE: Record<string, InfrastructureEntry> = {};
export let PROJECT_TYPE_COLORS: Record<string, string> = {};
export let DEPLOY_TIER_COLORS: Record<string, string> = {};
export let ANALYTICS_PROPERTIES: AnalyticsProperty[] = [];

export function initializeRegistry(registry: VaultRegistry) {
  if (!registry || !registry.projects) {
    logger.warn("No registry data — PROJECTS and INFRASTRUCTURE will be empty");
    return;
  }

  const projects: Record<string, ProjectEntry> = {};

  for (const service of registry.projects) {
    projects[service.id] = {
      name: service.label,
      url: service.url || "",
      port: service.port || null,
      healthPath: service.healthPath || "/",
      environment: "Production",
      visibility: service.visibility || "internal",
      projectType: inferProjectType(service.id, service),
      description: service.description || null,
      db: service.db || null,
      minioBucket: service.minioBucket || null,
      repo: normalizeRepoUrl(service.repo || null),
      npmPackage: service.npmPackage || null,
      device: service.device || "synology",
      domain: service.domain || null,
      dockerProject: service.dockerProject || null,
      deployTier: service.deployTier ?? inferDeployTier(inferProjectType(service.id, service)),
      essential: service.essential || false,
      watchdog: service.watchdog || null,
      dependsOn: deriveDependencies(service),
    };
  }

  PROJECTS = projects;

  // ── Analytics Properties ─────────────────────────────────────
  // Derive GA4 properties from project entries that declare an
  // analyticsPropertyId — replaces the old GOOGLE_ANALYTICS_PROPERTIES env var.
  ANALYTICS_PROPERTIES = (registry.projects || [])
    .filter((service: VaultRegistryProject) => service.analyticsPropertyId)
    .map((service: VaultRegistryProject) => ({
      id: service.analyticsPropertyId!,
      label: service.label,
      measurementId: service.analyticsMeasurementId || "",
      serviceId: service.id,
      domain: service.domain || null,
    }));

  const infra: Record<string, InfrastructureEntry> = {};

  const infraTypeLabels: Record<string, string> = { database: "Database", "object-store": "Store", inference: "Inference" };

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

  const devices: Record<string, DeviceEntry> = {};

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

// ── Cloud Monitoring (API Usage Dashboard) ────────────────────
// The GCP project ID to query for API usage metrics (serviceruntime.googleapis.com).
// This may differ from the GA4 service account's project_id when API keys
// (Places, YouTube, Geocoding, etc.) belong to a separate GCP project.
export const GOOGLE_CLOUD_MONITORING_PROJECT_ID = process.env.GOOGLE_CLOUD_MONITORING_PROJECT_ID;

// ── Sessions Service (first-party analytics) ──────────────────
export const SESSIONS_SERVICE_URL = process.env.SESSIONS_SERVICE_URL;
// Shared secret required by sessions-service /stats/* (they expose raw
// IPs/fingerprints, so the service fails closed without it).
export const SESSIONS_STATS_API_SECRET = process.env.SESSIONS_STATS_API_SECRET;

// ── Watchdog (dead-man's-switch + down alerting) ───────────────
// Path token authorizing heartbeat pushes — embedded in each pushing
// service's HEARTBEAT_URL. Watchdog push endpoints 503 without it.
export const WATCHDOG_PUSH_TOKEN = process.env.WATCHDOG_PUSH_TOKEN || "";
// Discord webhook that receives down/recovery alerts. Alerting is
// log-only when unset; state tracking still runs.
export const WATCHDOG_DISCORD_WEBHOOK_URL = process.env.WATCHDOG_DISCORD_WEBHOOK_URL || "";
// How often watchdog state is evaluated.
export const WATCHDOG_EVALUATE_INTERVAL_MS = 30_000;
// Push heartbeats arrive every ~60s; past this silence the pusher is down
// (~4 missed beats — matches the tolerance the Kuma monitor had).
export const WATCHDOG_PUSH_GRACE_MS = 4 * 60_000;
// Pull targets must stay unhealthy this long before alerting (2+ polls of
// the 60s health loop) — a single blip or in-place restart never pages.
export const WATCHDOG_CONFIRM_DOWN_MS = 90_000;
// Minimum gap between down alerts for one target — flapping can't spam.
export const WATCHDOG_ALERT_COOLDOWN_MS = 10 * 60_000;
