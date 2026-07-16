// ─── Centralized Types ─────────────────────────────────────


// ── Docker Engine API ──────────────────────────────────────────

export interface DockerActionResponse {
  statusCode: number;
  body: string;
}

export interface DockerTransport {
  socketPath?: string;
  hostname?: string;
  port?: number;
  path: string;
}

export interface CpuCounterState {
  cpuTotal: number;
  systemTotal: number;
}

export interface ContainerPort {
  ip: string;
  privatePort: number;
  publicPort: number;
  type: string;
}

export interface ContainerMount {
  type: string;
  name: string;
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

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

export interface DockerImageDisk {
  id: string;
  tags: string[];
  size: number;
  sharedSize: number;
  created: number;
  containers: number;
}

export interface DockerVolumeDisk {
  name: string;
  driver: string;
  size: number;
  refCount: number;
}

export interface HostDisk {
  total: number;
  used: number;
  available: number;
  percent: number;
}

// ── Registry & Config ──────────────────────────────────────────

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
  /** Watchdog mode from the registry: "push" (heartbeats), "off" (excluded), null/absent (pull). */
  watchdog?: string | null;
  dependsOn: DependencyRef[];
}

export interface DependencyRef {
  id: string;
  criticality: string;
}

export interface EnrichedDependency {
  id: string;
  name: string;
  criticality: string;
}

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

export interface DockerDeviceTarget {
  id: string;
  device: DeviceEntry;
}

export interface AnalyticsProperty {
  id: string;
  label: string;
  measurementId: string;
  serviceId: string;
  domain: string | null;
}

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
  watchdog?: string;
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

export interface BucketInfo {
  name: string;
  creationDate: string | null;
  objectCount: number;
  totalSize: number;
}

export type BucketStreamEvent =
  | { type: "init"; totalBuckets: number }
  | { type: "bucket"; bucket: BucketInfo };

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

export type GaReportRow = Record<string, string | number>;

export interface CacheEntry<T = unknown> {
  data: T;
  ts: number;
}

// ── Integrations ───────────────────────────────────────────────

export interface IntegrationDef {
  envKey: string;
  provider: string;
  category: string;
  docs: string;
}

export interface IntegrationStatus extends IntegrationDef {
  configured: boolean;
  maskedKey: string | null;
}

export interface IntegrationCategory {
  category: string;
  integrations: IntegrationStatus[];
  configuredCount: number;
  totalCount: number;
}

// ── Container Metrics ──────────────────────────────────────────

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

export interface MetricsHistoryOptions {
  container?: string;
  device?: string;
  range?: string;
  limit?: number;
}

export interface MetricsPoint {
  t: Date;
  cpu: number;
  mem: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  pids: number;
}

export interface MetricsHistoryResult {
  containers: Record<string, { device: string; points: MetricsPoint[] }>;
  range: string;
  since?: string;
  samples: number;
}

// ── TTL Cache Utilities ────────────────────────────────────────

export interface TtlCache<T> {
  get: (now: number) => T | null;
  set: (data: T, now: number) => void;
}

// ── Error Label Map ────────────────────────────────────────────

export const ERROR_CODE_LABELS: Record<string, string> = {
  ECONNREFUSED: "Connection refused",
  EHOSTUNREACH: "Host unreachable",
  ENETUNREACH: "Network unreachable",
  ECONNRESET: "Connection reset",
  ETIMEDOUT: "Connection timed out",
  ENOTFOUND: "DNS lookup failed",
  EPIPE: "Broken pipe",
};
