// ─── Runtime Configuration ──────────────────────────────────

import logger from "./utils/logger.ts";
import type { ProjectEntry, InfrastructureEntry, DeviceEntry, AnalyticsProperty, VaultRegistry, VaultRegistryProject } from "./types.ts";

export const PORT = process.env.PORTAL_SERVICE_PORT;

export const MONGO_URI = process.env.MONGO_URI;
export const MONGO_DB_NAME = process.env.PORTAL_SERVICE_MONGO_DB_NAME || process.env.MONGO_DB_NAME;

export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT;
export const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
export const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;

export const GITHUB_PAT = process.env.GITHUB_PAT || "";

// ── Devices ────────────────────────────────────────────────────
// Physical machines / hosts that run projects.
// Populated from the registry's `devices` section at boot.
export let DEVICES: Record<string, DeviceEntry> = {};

function inferProjectType(id: string, svc: VaultRegistryProject) {
  if (svc.projectType) return svc.projectType;
  if (!svc.repo && !svc.dockerProject) return "Infrastructure";
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
      repo: normalizeRepoUrl(svc.repo || null),
      npmPackage: svc.npmPackage || null,
      device: svc.device || "synology",
      domain: svc.domain || null,
      dockerProject: svc.dockerProject || null,
      deployTier: svc.deployTier ?? inferDeployTier(inferProjectType(svc.id, svc)),
      essential: svc.essential || false,
      dependsOn: (svc.dependsOn || []).map((dep: { id: string; criticality?: string }) => ({
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
    .filter((svc: VaultRegistryProject) => svc.analyticsPropertyId)
    .map((svc: VaultRegistryProject) => ({
      id: svc.analyticsPropertyId!,
      label: svc.label,
      measurementId: svc.analyticsMeasurementId || "",
      serviceId: svc.id,
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
