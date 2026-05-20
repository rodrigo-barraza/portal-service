// ─── Centralized Types ─────────────────────────────────────



// ── Docker Engine API ──────────────────────────────────────────

/** Response shape from DockerStatsService.dockerRequest() (POST/DELETE) */
export interface DockerActionResponse {
  statusCode: number;
  body: string;
}

/** Transport options resolved from a dockerApi URL */
export interface DockerTransport {
  socketPath?: string;
  hostname?: string;
  port?: number;
  path: string;
}

/** Per-container CPU counter state for delta computation */
export interface CpuCounterState {
  cpuTotal: number;
  systemTotal: number;
}

/** A single Docker container port mapping */
export interface ContainerPort {
  ip: string;
  privatePort: number;
  publicPort: number;
  type: string;
}

/** A single Docker container mount */
export interface ContainerMount {
  type: string;
  name: string;
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

/** Per-interface network I/O stats */
export interface NetworkInterfaceStats {
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
  rxDropped: number;
  txDropped: number;
  rxErrors: number;
  txErrors: number;
}

/** Parsed container stats returned by DockerStatsService */
export interface ContainerStats {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  command: string;
  ports: ContainerPort[];
  mounts: ContainerMount[];
  labels: Record<string, string>;
  device: string;
  cpu: { percent: number; cores: number };
  cpuThrottling: { periods: number; throttledPeriods: number; throttledTimeNs: number };
  memory: { used: number; limit: number; percent: number };
  memoryDetail: {
    rss: number;
    cache: number;
    swap: number;
    maxUsage: number;
    activeAnon: number;
    inactiveAnon: number;
    pgfault: number;
    pgmajfault: number;
  };
  network: {
    rx: number;
    tx: number;
    rxPackets: number;
    txPackets: number;
    rxDropped: number;
    txDropped: number;
    rxErrors: number;
    txErrors: number;
    interfaces: Record<string, NetworkInterfaceStats>;
  };
  blockIO: { read: number; write: number };
  pids: number;
}

/** Time-series snapshot for the ring buffer */
export interface ContainerSnapshot {
  timestamp: string;
  containers: Record<string, {
    cpu: number;
    memoryUsed: number;
    memoryLimit: number;
    memoryPercent: number;
    blockRead: number;
    blockWrite: number;
    netRx: number;
    netTx: number;
    pids: number;
  }>;
}

/** Docker image disk usage entry */
export interface DockerImageDisk {
  id: string;
  tags: string[];
  size: number;
  sharedSize: number;
  created: number;
  containers: number;
}

/** Docker volume disk usage entry */
export interface DockerVolumeDisk {
  name: string;
  driver: string;
  size: number;
  refCount: number;
}

/** Host-level disk stats */
export interface HostDisk {
  total: number;
  used: number;
  available: number;
  percent: number;
}

// ── Registry & Config ──────────────────────────────────────────

/** A registered project (service, client, bot, library, etc.) */
export interface ProjectEntry {
  name: string;
  url: string;
  port: number | null;
  healthPath: string;
  environment: string;
  visibility: string;
  projectType: string;
  description: string | null;
  db: string | null;
  minioBucket: string | null;
  repo: string | null;
  npmPackage: string | null;
  device: string;
  domain: string | null;
  dockerProject: string | null;
  deployTier: number;
  essential: boolean;
  dependsOn: DependencyRef[];
}

/** A dependency reference with criticality */
export interface DependencyRef {
  id: string;
  criticality: string;
}

/** An enriched dependency with resolved name */
export interface EnrichedDependency {
  id: string;
  name: string;
  criticality: string;
}

/** A registered infrastructure entry (database, object-store, inference) */
export interface InfrastructureEntry {
  name: string;
  type: string;
  projectType: string;
  url: string;
  port: number | null;
  healthPath: string | null;
  environment: string;
  visibility: string;
  device: string;
  domain: string | null;
  deployTier: number;
  dependsOn: DependencyRef[];
}

/** A device entry from the registry */
export interface DeviceEntry {
  name: string;
  type: string;
  hostname: string;
  os: string;
  sshAlias: string | null;
  dockerBin: string | null;
  dockerApi: string | null;
  notes: string;
  specs: Record<string, unknown> | null;
}

/** Resolved Docker host target */
export interface DockerDeviceTarget {
  id: string;
  device: DeviceEntry;
}

/** A GA4 analytics property */
export interface AnalyticsProperty {
  id: string;
  label: string;
  measurementId: string;
  serviceId: string;
}

/** Registry payload from vault */
export interface VaultRegistry {
  projects: VaultRegistryProject[];
  infrastructure: VaultRegistryInfra[];
  devices: VaultRegistryDevice[];
  projectTypeColors?: Record<string, string>;
  deployTierColors?: Record<string, string>;
}

export interface VaultRegistryProject {
  id: string;
  label: string;
  url?: string;
  port?: number;
  healthPath?: string;
  visibility?: string;
  projectType?: string;
  description?: string;
  db?: string;
  minioBucket?: string;
  repo?: string;
  npmPackage?: string;
  device?: string;
  domain?: string;
  dockerProject?: string;
  deployTier?: number;
  essential?: boolean;
  dependsOn?: Array<{ id: string; criticality?: string }>;
  analyticsPropertyId?: string;
  analyticsMeasurementId?: string;
}

export interface VaultRegistryInfra {
  id: string;
  label: string;
  type: string;
  url?: string;
  defaultPort?: number;
  healthPath?: string;
  device?: string;
  domain?: string;
  deployTier?: number;
}

export interface VaultRegistryDevice {
  id: string;
  label: string;
  type: string;
  hostname?: string;
  os?: string;
  sshAlias?: string;
  dockerBin?: string;
  dockerApi?: string;
  notes?: string;
  specs?: Record<string, unknown>;
}

// ── Service Status ─────────────────────────────────────────────

export interface ServiceStatus {
  id: string;
  name: string;
  url: string;
  port: number | null;
  environment: string;
  visibility: string;
  projectType: string | null;
  description: string | null;
  db: string | null;
  minioBucket: string | null;
  repo: string | null;
  npmPackage: string | null;
  device: string;
  domain: string | null;
  dependsOn: DependencyRef[] | EnrichedDependency[];
  dependedOnBy?: EnrichedDependency[];
  deployTier: number | null;
  essential: boolean;
  restartable: boolean;
  dockerProject: string | null;
  healthy: boolean;
  responseTimeMs: number | null;
  metadata: Record<string, unknown> | null;
  error: string | null;
  checkedAt: string | null;
}

export interface InfraStatus {
  id: string;
  name: string;
  type: string;
  projectType: string | null;
  url: string;
  port: number | null;
  environment: string;
  visibility: string;
  domain: string | null;
  device: string;
  dependsOn: DependencyRef[] | EnrichedDependency[];
  dependedOnBy?: EnrichedDependency[];
  deployTier: number;
  healthy: boolean;
  responseTimeMs: number | null;
  metadata: Record<string, unknown> | null;
  error: string | null;
  checkedAt: string | null;
  isInfrastructure: boolean;
}

// ── MinIO Service ──────────────────────────────────────────────

/** Enriched bucket info returned by MinioService.listBuckets() */
export interface BucketInfo {
  name: string;
  creationDate: string | null;
  objectCount: number;
  totalSize: number;
}

/** SSE event types from MinioService.streamBuckets() */
export type BucketStreamEvent =
  | { type: "init"; totalBuckets: number }
  | { type: "bucket"; bucket: BucketInfo };

/** Object listing result */
export interface ObjectListResult {
  objects: ObjectInfo[];
  prefixes: string[];
}

export interface ObjectInfo {
  name: string;
  size: number;
  lastModified: string | null;
  etag: string | null;
}

// ── Google Analytics ───────────────────────────────────────────

/** A formatted GA4 report row */
export type GaReportRow = Record<string, string | number>;

/** TTL cache entry */
export interface CacheEntry<T = unknown> {
  data: T;
  ts: number;
}

// ── Integrations ───────────────────────────────────────────────

/** An integration provider definition */
export interface IntegrationDef {
  envKey: string;
  provider: string;
  category: string;
  docs: string;
}

/** An enriched integration with configured status */
export interface IntegrationStatus extends IntegrationDef {
  configured: boolean;
  maskedKey: string | null;
}

/** Integration category group */
export interface IntegrationCategory {
  category: string;
  integrations: IntegrationStatus[];
  configuredCount: number;
  totalCount: number;
}

// ── Container Metrics ──────────────────────────────────────────

/** A persisted metrics document */
export interface MetricsDocument {
  timestamp: Date;
  metadata: {
    container: string;
    device: string;
  };
  cpu: number;
  memoryUsed: number;
  memoryLimit: number;
  memoryPercent: number;
  netRx: number;
  netTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
}

/** Container metrics history query options */
export interface MetricsHistoryOptions {
  container?: string;
  device?: string;
  range?: string;
  limit?: number;
}

/** A single history data point */
export interface MetricsPoint {
  t: Date;
  cpu: number;
  mem: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  pids: number;
}

/** Container history response */
export interface MetricsHistoryResult {
  containers: Record<string, { device: string; points: MetricsPoint[] }>;
  range: string;
  since?: string;
  samples: number;
}

// ── TTL Cache Utilities ────────────────────────────────────────

/** Generic TTL cache for sizes/languages endpoints */
export interface TtlCache<T> {
  get: (now: number) => T | null;
  set: (data: T, now: number) => void;
}

// ── Error Label Map ────────────────────────────────────────────

/** Known fetch error code labels */
export const ERROR_CODE_LABELS: Record<string, string> = {
  ECONNREFUSED: "Connection refused",
  EHOSTUNREACH: "Host unreachable",
  ENETUNREACH: "Network unreachable",
  ECONNRESET: "Connection reset",
  ETIMEDOUT: "Connection timed out",
  ENOTFOUND: "DNS lookup failed",
  EPIPE: "Broken pipe",
};
