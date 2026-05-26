// ─── Docker Stats Service (Multi-Host) ──────────────────────

import http, { IncomingMessage } from "http";
import { execSync } from "child_process";
import os from "os";
import logger from "../utils/logger.ts";
import { DEVICES } from "../config.ts";
import ContainerMetricsService from "./ContainerMetricsService.ts";
import type { DockerActionResponse, DockerTransport, DeviceEntry, ContainerStats, ContainerSnapshot, NetworkInterfaceStats } from "../types.ts";

// ── Docker API response sub-structures ───────────────────────────
interface DockerCpuUsage {
  total_usage: number;
  percpu_usage?: number[];
}
interface DockerCpuStats {
  cpu_usage: DockerCpuUsage;
  system_cpu_usage: number;
  online_cpus?: number;
  throttling_data?: { periods?: number; throttled_periods?: number; throttled_time?: number };
}
interface DockerMemoryStats {
  usage?: number;
  limit?: number;
  max_usage?: number;
  stats?: {
    cache?: number;
    inactive_file?: number;
    rss?: number;
    swap?: number;
    active_anon?: number;
    inactive_anon?: number;
    pgfault?: number;
    pgmajfault?: number;
  };
}
interface DockerBlkioEntry { op: string; value: number }
interface DockerBlkioStats {
  io_service_bytes_recursive?: DockerBlkioEntry[];
}
interface DockerPidsStats {
  current?: number;
}

const STATS_CACHE_TTL_MS = 10_000;
const SYSTEM_CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const SYSTEM_REQUEST_TIMEOUT_MS = 30_000;

// ── Ring Buffer Config ───────────────────────────────────────────
const HISTORY_INTERVAL_MS = 5_000;
const HISTORY_MAX_SAMPLES = 60;

// ── Per-Host State ───────────────────────────────────────────────
// Each Docker host gets isolated state keyed by device ID.

const statsCacheMap = new Map();

const systemCacheMap = new Map();

const cpuCounterMap = new Map();


const historyMap = new Map();

const lastPersistMap = new Map();


// ── Transport Parsing ────────────────────────────────────────────

function parseTransport(dockerApi: string, path: string): DockerTransport {
  if (dockerApi.startsWith("unix://")) {
    return { socketPath: dockerApi.slice(7), path };
  }

  if (dockerApi.startsWith("tcp://")) {
    const url = new URL(dockerApi.replace("tcp://", "http://"));
    return {
      hostname: url.hostname,
      port: parseInt(url.port, 10) || 2375,
      path,
    };
  }

  throw new Error(`Unsupported Docker API protocol: ${dockerApi}`);
}

function getDockerDevices(): Array<{ id: string; device: DeviceEntry }> {
  return Object.entries(DEVICES)
    .filter(([, dev]) => dev.dockerApi)
    .map(([id, dev]) => ({ id, device: dev }));
}

export default class DockerStatsService {
    static async getAll(deviceId?: string) {
    const devices = getDockerDevices();
    const targets = deviceId
      ? devices.filter((d) => d.id === deviceId)
      : devices;

    if (targets.length === 0) return [];

    const results = await Promise.allSettled(
      targets.map((t) => DockerStatsService._getAllForDevice(t.id, t.device)),
    );

    const combined: ContainerStats[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        combined.push(...result.value);
      }
    }

    return combined.sort((a, b) => a.name.localeCompare(b.name));
  }

    static async _getAllForDevice(deviceId: string, device: DeviceEntry): Promise<ContainerStats[]> {
    const cached = statsCacheMap.get(deviceId);
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const containers = await DockerStatsService._listContainers(device);
      const stats = await Promise.all(
        containers.map((c: Record<string, unknown>) => {
          if (c.State !== "running") {
            return DockerStatsService._buildStoppedSkeleton(c, deviceId);
          }
          return DockerStatsService._getContainerStats(c, device, deviceId);
        }),
      );

      const result = (stats.filter(Boolean) as ContainerStats[]).sort((a, b) => a.name.localeCompare(b.name));

      // Prune stale CPU counters for this device
      const counters = cpuCounterMap.get(deviceId);
      if (counters) {
        const activeIds = new Set(containers.map((c: Record<string, unknown>) => c.Id));
        for (const id of counters.keys()) {
          if (!activeIds.has(id)) counters.delete(id);
        }
      }

      statsCacheMap.set(deviceId, { data: result, fetchedAt: Date.now() });
      return result;
    } catch (error: unknown) {
      const errorObject = error as Error;
      logger.error(`[DockerStats:${deviceId}] Failed to collect stats: ${errorObject.message}`);
      const stale = statsCacheMap.get(deviceId);
      if (stale) return stale.data;
      return [];
    }
  }

    static getHistory(deviceId?: string) {
    if (deviceId) {
      return { [deviceId]: historyMap.get(deviceId) || [] };
    }

    const allHistory: Record<string, ContainerSnapshot[]> = {};
    for (const [id, buf] of historyMap) {
      allHistory[id] = buf;
    }
    return allHistory;
  }

    static invalidate(deviceId?: string) {
    if (deviceId) {
      statsCacheMap.delete(deviceId);
      systemCacheMap.delete(deviceId);
    } else {
      statsCacheMap.clear();
      systemCacheMap.clear();
    }
  }

  static collectorTimer: ReturnType<typeof setInterval> | null = null;

    static startCollector() {
    if (DockerStatsService.collectorTimer) return;

    DockerStatsService._collectSnapshot();
    DockerStatsService.collectorTimer = setInterval(
      () => DockerStatsService._collectSnapshot(),
      HISTORY_INTERVAL_MS,
    );

    const devices = getDockerDevices();
    logger.info(`[DockerStats] Ring buffer collector started — ${devices.length} Docker host(s) (every ${HISTORY_INTERVAL_MS / 1000}s, ${HISTORY_MAX_SAMPLES} max samples)`);
  }

    static stopCollector() {
    if (DockerStatsService.collectorTimer) {
      clearInterval(DockerStatsService.collectorTimer);
      DockerStatsService.collectorTimer = null;
    }
  }

    static async _collectSnapshot() {
    const devices = getDockerDevices();

    await Promise.allSettled(
      devices.map(({ id, device }) =>
        DockerStatsService._collectDeviceSnapshot(id, device),
      ),
    );
  }

    static async _collectDeviceSnapshot(deviceId: string, device: DeviceEntry) {
    try {
      const stats = await DockerStatsService._getAllForDevice(deviceId, device);

      const snapshot = {
        timestamp: new Date().toISOString(),
        containers: {} as ContainerSnapshot["containers"],
      };

      for (const s of stats) {
        snapshot.containers[s.name] = {
          cpu: s.cpu.percent,
          memoryUsed: s.memory.used,
          memoryLimit: s.memory.limit,
          memoryPercent: s.memory.percent,
          blockRead: s.blockIO.read,
          blockWrite: s.blockIO.write,
          netRx: s.network.rx,
          netTx: s.network.tx,
          pids: s.pids,
        };
      }

      if (!historyMap.has(deviceId)) {
        historyMap.set(deviceId, []);
      }

      const history = historyMap.get(deviceId);
      history.push(snapshot);
      while (history.length > HISTORY_MAX_SAMPLES) {
        history.shift();
      }

      // ── Persist to MongoDB (throttled to 30s intervals) ────────
      const now = Date.now();
      const lastPersist = lastPersistMap.get(deviceId) || 0;
      if (now - lastPersist >= ContainerMetricsService.persistIntervalMs) {
        lastPersistMap.set(deviceId, now);
        ContainerMetricsService.persistSnapshot(deviceId, stats).catch((errorObject: unknown) => {
          logger.warn(`[DockerStats:${deviceId}] Metrics persist failed: ${(errorObject as Error).message}`);
        });
      }
    } catch (error: unknown) {
      const errorObject = error as Error;
      logger.warn(`[DockerStats:${deviceId}] Snapshot failed: ${errorObject.message}`);
    }
  }

  // ── Docker Engine API Calls ──────────────────────────────────

    static async _listContainers(device: DeviceEntry): Promise<Record<string, unknown>[]> {
    const body = await DockerStatsService._dockerGet(
      device,
      "/containers/json?all=true",
    );
    return JSON.parse(body);
  }

    static async _getContainerStats(container: Record<string, unknown>, device: DeviceEntry, deviceId: string): Promise<ContainerStats | null> {
    try {
      const body = await DockerStatsService._dockerGet(
        device,
        `/containers/${container.Id}/stats?stream=false&one-shot=true`,
      );
      const raw = JSON.parse(body);
      return DockerStatsService._parseStats(container, raw, deviceId);
    } catch (error: unknown) {
      const errorObject = error as Error;
      logger.warn(
        `[DockerStats:${deviceId}] Failed to get stats for ${(container.Names as string[] | undefined)?.[0]}: ${errorObject.message}`,
      );
      return null;
    }
  }

    static _buildStoppedSkeleton(container: Record<string, unknown>, deviceId: string): ContainerStats {
    const name = ((container.Names as string[] | undefined)?.[0] || "unknown").replace(/^\//, "");
    const command = (container.Command as string) || "";
    const ports = ((container.Ports as Record<string, unknown>[]) || []).map((p: Record<string, unknown>) => ({
      ip: (p.IP as string) || "",
      privatePort: p.PrivatePort as number,
      publicPort: p.PublicPort as number,
      type: p.Type as string,
    }));
    const mounts = ((container.Mounts as Record<string, unknown>[]) || []).map((m: Record<string, unknown>) => ({
      type: m.Type as string,
      name: (m.Name as string) || "",
      source: m.Source as string,
      destination: m.Destination as string,
      mode: (m.Mode as string) || "rw",
      rw: (m.RW as boolean) ?? true,
    }));
    const labels = (container.Labels as Record<string, string>) || {};

    return {
      id: (container.Id as string).substring(0, 12),
      name,
      image: container.Image as string,
      state: container.State as string,
      status: container.Status as string,
      created: container.Created as number,
      command,
      ports,
      mounts,
      labels,
      device: deviceId,
      cpu: { percent: 0, cores: 0 },
      cpuThrottling: { periods: 0, throttledPeriods: 0, throttledTimeNs: 0 },
      memory: { used: 0, limit: 0, percent: 0 },
      memoryDetail: {
        rss: 0, cache: 0, swap: 0, maxUsage: 0,
        activeAnon: 0, inactiveAnon: 0, pgfault: 0, pgmajfault: 0,
      },
      network: {
        rx: 0, tx: 0, rxPackets: 0, txPackets: 0,
        rxDropped: 0, txDropped: 0, rxErrors: 0, txErrors: 0,
        interfaces: {},
      },
      blockIO: { read: 0, write: 0 },
      pids: 0,
    };
  }

    static _parseStats(container: Record<string, unknown>, raw: Record<string, unknown>, deviceId: string): ContainerStats {
    // ── CPU (self-tracked deltas) ──────────────────────────────
    const cpuStats = raw.cpu_stats as DockerCpuStats;
    const currentCpuTotal = cpuStats?.cpu_usage?.total_usage || 0;
    const currentSystemTotal = cpuStats?.system_cpu_usage || 0;
    const numCpus =
      cpuStats?.online_cpus ||
      cpuStats?.cpu_usage?.percpu_usage?.length ||
      1;

    // Get or create per-device CPU counter map
    if (!cpuCounterMap.has(deviceId)) {
      cpuCounterMap.set(deviceId, new Map());
    }
    const deviceCounters = cpuCounterMap.get(deviceId);
    const prev = deviceCounters.get(container.Id);

    let cpuPercent = 0;
    if (prev) {
      const cpuDelta = currentCpuTotal - prev.cpuTotal;
      const systemDelta = currentSystemTotal - prev.systemTotal;
      if (systemDelta > 0 && cpuDelta > 0) {
        cpuPercent = (cpuDelta / systemDelta) * numCpus * 100;
      }
    }

    deviceCounters.set(container.Id, {
      cpuTotal: currentCpuTotal,
      systemTotal: currentSystemTotal,
    });

    // ── Memory ─────────────────────────────────────────────────
    const memStats = raw.memory_stats as DockerMemoryStats;
    const memUsage = memStats?.usage || 0;
    const memCache = memStats?.stats?.cache || memStats?.stats?.inactive_file || 0;
    const memActual = memUsage - memCache;
    const memLimit = memStats?.limit || 0;
    const memPercent = memLimit > 0 ? (memActual / memLimit) * 100 : 0;

    // ── Network I/O ────────────────────────────────────────────
    let netRx = 0, netTx = 0, netRxPackets = 0, netTxPackets = 0;
    let netRxDropped = 0, netTxDropped = 0, netRxErrors = 0, netTxErrors = 0;
    const networkInterfaces: Record<string, NetworkInterfaceStats> = {};
    if (raw.networks) {
      for (const [ifaceName, iface] of Object.entries(raw.networks) as [string, Record<string, number>][]) {
        netRx += iface.rx_bytes || 0;
        netTx += iface.tx_bytes || 0;
        netRxPackets += iface.rx_packets || 0;
        netTxPackets += iface.tx_packets || 0;
        netRxDropped += iface.rx_dropped || 0;
        netTxDropped += iface.tx_dropped || 0;
        netRxErrors += iface.rx_errors || 0;
        netTxErrors += iface.tx_errors || 0;
        networkInterfaces[ifaceName] = {
          rxBytes: iface.rx_bytes || 0,
          txBytes: iface.tx_bytes || 0,
          rxPackets: iface.rx_packets || 0,
          txPackets: iface.tx_packets || 0,
          rxDropped: iface.rx_dropped || 0,
          txDropped: iface.tx_dropped || 0,
          rxErrors: iface.rx_errors || 0,
          txErrors: iface.tx_errors || 0,
        };
      }
    }

    // ── Block I/O ──────────────────────────────────────────────
    let blockRead = 0, blockWrite = 0;
    const blkioStats = raw.blkio_stats as DockerBlkioStats;
    if (blkioStats?.io_service_bytes_recursive) {
      for (const entry of blkioStats.io_service_bytes_recursive) {
        if (entry.op === "read" || entry.op === "Read") blockRead += entry.value || 0;
        if (entry.op === "write" || entry.op === "Write") blockWrite += entry.value || 0;
      }
    }

    // ── PIDs ───────────────────────────────────────────────────
    const pidsStats = raw.pids_stats as DockerPidsStats;
    const pids = pidsStats?.current || 0;

    // ── Memory Detail ─────────────────────────────────────────
    const memoryDetail = {
      rss: memStats?.stats?.rss || 0,
      cache: memCache,
      swap: memStats?.stats?.swap || 0,
      maxUsage: memStats?.max_usage || 0,
      activeAnon: memStats?.stats?.active_anon || 0,
      inactiveAnon: memStats?.stats?.inactive_anon || 0,
      pgfault: memStats?.stats?.pgfault || 0,
      pgmajfault: memStats?.stats?.pgmajfault || 0,
    };

    // ── CPU Throttling ────────────────────────────────────────
    const throttling = cpuStats?.throttling_data || {};
    const cpuThrottling = {
      periods: throttling.periods || 0,
      throttledPeriods: throttling.throttled_periods || 0,
      throttledTimeNs: throttling.throttled_time || 0,
    };

    // ── Container Metadata ────────────────────────────────────
    const command = (container.Command as string) || "";
    const ports = ((container.Ports as Record<string, unknown>[]) || []).map((p: Record<string, unknown>) => ({
      ip: (p.IP as string) || "",
      privatePort: p.PrivatePort as number,
      publicPort: p.PublicPort as number,
      type: p.Type as string,
    }));
    const mounts = ((container.Mounts as Record<string, unknown>[]) || []).map((m: Record<string, unknown>) => ({
      type: m.Type as string,
      name: (m.Name as string) || "",
      source: m.Source as string,
      destination: m.Destination as string,
      mode: (m.Mode as string) || "rw",
      rw: (m.RW as boolean) ?? true,
    }));
    const labels = (container.Labels as Record<string, string>) || {};
    const name = ((container.Names as string[] | undefined)?.[0] || "unknown").replace(/^\//, "");

    return {
      id: (container.Id as string).substring(0, 12),
      name,
      image: container.Image as string,
      state: container.State as string,
      status: container.Status as string,
      created: container.Created as number,
      command,
      ports,
      mounts,
      labels,
      device: deviceId,
      cpu: {
        percent: Math.round(cpuPercent * 100) / 100,
        cores: numCpus,
      },
      cpuThrottling,
      memory: {
        used: memActual,
        limit: memLimit,
        percent: Math.round(memPercent * 100) / 100,
      },
      memoryDetail,
      network: {
        rx: netRx, tx: netTx,
        rxPackets: netRxPackets, txPackets: netTxPackets,
        rxDropped: netRxDropped, txDropped: netTxDropped,
        rxErrors: netRxErrors, txErrors: netTxErrors,
        interfaces: networkInterfaces,
      },
      blockIO: { read: blockRead, write: blockWrite },
      pids,
    };
  }

    static async getSystemInfo(deviceId?: string) {
    const devices = getDockerDevices();

    if (deviceId) {
      const target = devices.find((d) => d.id === deviceId);
      if (!target) throw new Error(`Unknown Docker device: ${deviceId}`);
      return DockerStatsService._getSystemInfoForDevice(target.id, target.device);
    }

    // Return system info for all Docker hosts
    const results = await Promise.allSettled(
      devices.map((t) =>
        DockerStatsService._getSystemInfoForDevice(t.id, t.device)
          .then((info) => ({ deviceId: t.id, deviceName: t.device.name, ...info })),
      ),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<Record<string, unknown>> => r.status === "fulfilled")
      .map((r) => r.value);
  }

    static async _getSystemInfoForDevice(deviceId: string, device: DeviceEntry) {
    const cached = systemCacheMap.get(deviceId);
    if (cached && Date.now() - cached.fetchedAt < SYSTEM_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const [infoBody, dfBody] = await Promise.all([
        DockerStatsService._dockerGet(device, "/info", SYSTEM_REQUEST_TIMEOUT_MS),
        DockerStatsService._dockerGet(device, "/system/df", SYSTEM_REQUEST_TIMEOUT_MS),
      ]);

      const info = JSON.parse(infoBody);
      const df = JSON.parse(dfBody);

      // ── Image disk usage ────────────────────────────────────
      const images = ((df.Images as Record<string, unknown>[]) || []).map((image: Record<string, unknown>) => ({
        id: (image.Id as string)?.substring(0, 12) || "unknown",
        tags: (image.RepoTags as string[]) || [],
        size: (image.Size as number) || 0,
        sharedSize: (image.SharedSize as number) || 0,
        created: image.Created as number,
        containers: (image.Containers as number) || 0,
      }));

      const totalImageSize = images.reduce((sum: number, image: { size: number }) => sum + image.size, 0);
      const totalImageShared = images.reduce((sum: number, image: { sharedSize: number }) => sum + image.sharedSize, 0);

      // ── Volume disk usage ───────────────────────────────────
      const volumes = ((df.Volumes as Record<string, unknown>[]) || []).map((vol: Record<string, unknown>) => ({
        name: vol.Name as string,
        driver: vol.Driver as string,
        size: (vol.UsageData as Record<string, number>)?.Size || 0,
        refCount: (vol.UsageData as Record<string, number>)?.RefCount || 0,
      }));

      const totalVolumeSize = volumes.reduce((sum: number, vol: { size: number }) => sum + vol.size, 0);

      // ── Build cache disk usage ──────────────────────────────
      const buildCache = (df.BuildCache as Record<string, unknown>[]) || [];
      const totalBuildCacheSize = buildCache.reduce(
        (sum: number, entry: Record<string, unknown>) => sum + ((entry.Size as number) || 0),
        0,
      );

      // ── Container disk usage ────────────────────────────────
      const containersDf = ((df.Containers as Record<string, unknown>[]) || []).map((c: Record<string, unknown>) => ({
        id: (c.Id as string)?.substring(0, 12) || "unknown",
        names: (c.Names as string[]) || [],
        sizeRw: (c.SizeRw as number) || 0,
        sizeRootFs: (c.SizeRootFs as number) || 0,
        state: c.State as string,
      }));

      const totalContainerRw = containersDf.reduce(
        (sum: number, c: { sizeRw: number }) => sum + c.sizeRw,
        0,
      );

      // ── Host-level disk stats ──────────────────────────────
      // Only available for the local host (Unix socket)
      let hostDisk: { total: number; used: number; available: number; percent: number } | null = null;
      if (device.dockerApi?.startsWith("unix://")) {
        try {
          const dfOutput = execSync("df -B1 / | tail -1", { encoding: "utf8", timeout: 3000 });
          const parts = dfOutput.trim().split(/\s+/);
          if (parts.length >= 5) {
            const total = parseInt(parts[1], 10) || 0;
            const used = parseInt(parts[2], 10) || 0;
            const available = parseInt(parts[3], 10) || 0;
            const percent = total > 0 ? Math.round((used / total) * 10000) / 100 : 0;
            hostDisk = { total, used, available, percent };
          }
        } catch (dfError: unknown) {
          logger.warn(`[DockerStats:${deviceId}] Host disk stats failed: ${(dfError as Error).message}`);
        }
      }

      const result = {
        deviceId,
        serverVersion: info.ServerVersion,
        os: info.OperatingSystem,
        architecture: info.Architecture,
        totalMemory: info.MemTotal || (device.dockerApi?.startsWith("unix://") ? os.totalmem() : 0),
        cpus: info.NCPU || (device.dockerApi?.startsWith("unix://") ? os.cpus().length : 0),
        containersRunning: info.ContainersRunning,
        containersStopped: info.ContainersStopped,
        containersPaused: info.ContainersPaused,
        containersTotal: info.Containers,
        hostDisk,
        disk: {
          images: {
            count: images.length,
            totalSize: totalImageSize,
            sharedSize: totalImageShared,
            items: images.sort((a: { size: number }, b: { size: number }) => b.size - a.size).slice(0, 20),
          },
          volumes: {
            count: volumes.length,
            totalSize: totalVolumeSize,
            items: volumes.sort((a: { size: number }, b: { size: number }) => b.size - a.size),
          },
          buildCache: {
            count: buildCache.length,
            totalSize: totalBuildCacheSize,
          },
          containers: {
            count: containersDf.length,
            totalWritableSize: totalContainerRw,
          },
          totalReclaimable:
            totalImageSize + totalVolumeSize + totalBuildCacheSize + totalContainerRw,
        },
        fetchedAt: new Date().toISOString(),
      };

      systemCacheMap.set(deviceId, { data: result, fetchedAt: Date.now() });
      return result;
    } catch (error: unknown) {
      const errorObject = error as Error;
      logger.error(`[DockerStats:${deviceId}] System info failed: ${errorObject.message}`);
      const stale = systemCacheMap.get(deviceId);
      if (stale) return stale.data;
      throw errorObject;
    }
  }

  // ── Transport Layer ────────────────────────────────────────────

    static _dockerGet(device: DeviceEntry, path: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const transport = parseTransport(device.dockerApi!, path);

      const req = http.request(
        {
          ...transport,
          method: "GET",
          headers: { Accept: "application/json" },
        },
        (res: IncomingMessage) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body);
            } else {
              reject(
                new Error(
                  `Docker API ${res.statusCode}: ${body.substring(0, 200)}`,
                ),
              );
            }
          });
        },
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Docker API timeout after ${timeoutMs}ms`));
      });

      req.on("error", reject);
      req.end();
    });
  }

    static dockerRequest(device: DeviceEntry, method: string, path: string, { timeout = 30_000 }: { timeout?: number } = {}): Promise<DockerActionResponse> {
    return new Promise<DockerActionResponse>((resolve, reject) => {
      const transport = parseTransport(device.dockerApi!, path);

      const req = http.request(
        {
          ...transport,
          method,
          headers: { "Content-Type": "application/json" },
        },
        (res: IncomingMessage) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk));
          res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
        },
      );

      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Docker API timeout after ${timeout}ms`));
      });

      req.on("error", reject);
      req.end();
    });
  }

    static dockerGet(device: DeviceEntry, path: string, timeoutMs?: number): Promise<string> {
    return DockerStatsService._dockerGet(device, path, timeoutMs);
  }
}

// ── Auto-start collector on import ────────────────────────────────
DockerStatsService.startCollector();
