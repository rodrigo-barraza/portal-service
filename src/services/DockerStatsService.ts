// ─── Docker Stats Service (Multi-Host) ──────────────────────

import http from "http";
import { execSync } from "child_process";
import os from "os";
import logger from "../utils/logger.ts";
import { DEVICES } from "../config.ts";
import ContainerMetricsService from "./ContainerMetricsService.ts";

const STATS_CACHE_TTL_MS = 10_000;
const SYSTEM_CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const SYSTEM_REQUEST_TIMEOUT_MS = 30_000;

// ── Ring Buffer Config ───────────────────────────────────────────
const HISTORY_INTERVAL_MS = 5_000;
const HISTORY_MAX_SAMPLES = 60;

// ── Per-Host State ───────────────────────────────────────────────
// Each Docker host gets isolated state keyed by device ID.

/** @type {Map<string, { data: any, fetchedAt: number }>} */
const statsCacheMap = new Map();

/** @type {Map<string, { data: any, fetchedAt: number }>} */
const systemCacheMap = new Map();

/** @type {Map<string, Map<string, { cpuTotal: number, systemTotal: number }>>} */
const cpuCounterMap = new Map();


const historyMap = new Map();

/** @type {Map<string, number>} — per-device last-persist timestamp for throttling writes */
const lastPersistMap = new Map();

/** Timer reference for cleanup on shutdown. */

// ── Transport Parsing ────────────────────────────────────────────

/**
 * Parse a dockerApi URL into http.request options.


 * @returns {{ socketPath?: string, hostname?: string, port?: number, path: string }}
 */
function parseTransport(dockerApi: any, path: any) {
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

/**
 * Get the list of device entries that have Docker API configured.
 * @returns {Array<{ id: string, device: object }>}
 */
function getDockerDevices() {
  return Object.entries(DEVICES)
    .filter(([, dev]: any) => dev.dockerApi)
    .map(([id, dev]: any) => ({ id, device: dev }));
}

export default class DockerStatsService {
  /**
   * Get resource stats for all containers across all Docker hosts,
   * or filtered to a single device.


   */
  static async getAll(deviceId: any) {
    const devices = getDockerDevices();
    const targets = deviceId
      ? devices.filter((d: any) => d.id === deviceId)
      : devices;

    if (targets.length === 0) return [];

    const results = await Promise.allSettled(
      targets.map((t: any) => DockerStatsService._getAllForDevice(t.id, t.device)),
    );

    const combined: any[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        combined.push(...result.value);
      }
    }

    return combined.sort((a: any, b: any) => a.name.localeCompare(b.name));
  }

  /**
   * Get stats for a single Docker host. Uses per-device cache.


   */
  static async _getAllForDevice(deviceId: any, device: any) {
    const cached = statsCacheMap.get(deviceId);
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const containers = await DockerStatsService._listContainers(device);
      const stats = await Promise.all(
        containers.map((c: any) => {
          if (c.State !== "running") {
            return DockerStatsService._buildStoppedSkeleton(c, deviceId);
          }
          return DockerStatsService._getContainerStats(c, device, deviceId);
        }),
      );

      const result = stats.filter(Boolean).sort((a: any, b: any) => a.name.localeCompare(b.name));

      // Prune stale CPU counters for this device
      const counters = cpuCounterMap.get(deviceId);
      if (counters) {
        const activeIds = new Set(containers.map((c: any) => c.Id));
        for (const id of counters.keys()) {
          if (!activeIds.has(id)) counters.delete(id);
        }
      }

      statsCacheMap.set(deviceId, { data: result, fetchedAt: Date.now() });
      return result;
    } catch (error: any) {
      logger.error(`[DockerStats:${deviceId}] Failed to collect stats: ${error.message}`);
      const stale = statsCacheMap.get(deviceId);
      if (stale) return stale.data;
      return [];
    }
  }

  /**
   * Get the historical time-series ring buffer.


   */
  static getHistory(deviceId: any) {
    if (deviceId) {
      return { [deviceId]: historyMap.get(deviceId) || [] };
    }

    const allHistory: Record<string, any> = {};
    for (const [id, buf] of historyMap) {
      allHistory[id] = buf;
    }
    return allHistory;
  }

  /**
   * Invalidate all caches (or for a specific device).

   */
  static invalidate(deviceId: any) {
    if (deviceId) {
      statsCacheMap.delete(deviceId);
      systemCacheMap.delete(deviceId);
    } else {
      statsCacheMap.clear();
      systemCacheMap.clear();
    }
  }

  static collectorTimer: any = null;

  /**
   * Start the background collector that populates ring buffers for all hosts.
   */
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

  /**
   * Stop the background collector.
   */
  static stopCollector() {
    if (DockerStatsService.collectorTimer) {
      clearInterval(DockerStatsService.collectorTimer);
      DockerStatsService.collectorTimer = null;
    }
  }

  /**
   * Collect snapshots from all Docker hosts in parallel.
   * @private
   */
  static async _collectSnapshot() {
    const devices = getDockerDevices();

    await Promise.allSettled(
      devices.map(({ id, device }: any) =>
        DockerStatsService._collectDeviceSnapshot(id, device),
      ),
    );
  }

  /**
   * Collect a single snapshot for one device and push into its ring buffer.
   * @private
   */
  static async _collectDeviceSnapshot(deviceId: any, device: any) {
    try {
      const stats = await DockerStatsService._getAllForDevice(deviceId, device);

      const snapshot = {
        timestamp: new Date().toISOString(),
        containers: {} as Record<string, any>,
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
        ContainerMetricsService.persistSnapshot(deviceId, stats).catch((err: any) => {
          logger.warn(`[DockerStats:${deviceId}] Metrics persist failed: ${err.message}`);
        });
      }
    } catch (error: any) {
      logger.warn(`[DockerStats:${deviceId}] Snapshot failed: ${error.message}`);
    }
  }

  // ── Docker Engine API Calls ──────────────────────────────────

  /**
   * List all containers (running + stopped) on a device.


   */
  static async _listContainers(device: any) {
    const body = await DockerStatsService._dockerGet(
      device,
      "/containers/json?all=true",
    );
    return JSON.parse(body as string);
  }

  /**
   * Get one-shot stats for a single container.


   */
  static async _getContainerStats(container: any, device: any, deviceId: any) {
    try {
      const body = await DockerStatsService._dockerGet(
        device,
        `/containers/${container.Id}/stats?stream=false&one-shot=true`,
      );
      const raw = JSON.parse(body as string);
      return DockerStatsService._parseStats(container, raw, deviceId);
    } catch (error: any) {
      logger.warn(
        `[DockerStats:${deviceId}] Failed to get stats for ${container.Names?.[0]}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Build a zeroed-stats skeleton for a stopped/exited container.


   */
  static _buildStoppedSkeleton(container: any, deviceId: any) {
    const name = (container.Names?.[0] || "unknown").replace(/^\//, "");
    const command = container.Command || "";
    const ports = (container.Ports || []).map((p: any) => ({
      ip: p.IP || "",
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort,
      type: p.Type,
    }));
    const mounts = (container.Mounts || []).map((m: any) => ({
      type: m.Type,
      name: m.Name || "",
      source: m.Source,
      destination: m.Destination,
      mode: m.Mode || "rw",
      rw: m.RW ?? true,
    }));
    const labels = container.Labels || {};

    return {
      id: container.Id.substring(0, 12),
      name,
      image: container.Image,
      state: container.State,
      status: container.Status,
      created: container.Created,
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

  /**
   * Parse raw Docker stats into a clean, displayable format.
   * Uses per-device cached previous counters for CPU delta computation.


   */
  static _parseStats(container: any, raw: any, deviceId: any) {
    // ── CPU (self-tracked deltas) ──────────────────────────────
    const currentCpuTotal = raw.cpu_stats?.cpu_usage?.total_usage || 0;
    const currentSystemTotal = raw.cpu_stats?.system_cpu_usage || 0;
    const numCpus =
      raw.cpu_stats?.online_cpus ||
      raw.cpu_stats?.cpu_usage?.percpu_usage?.length ||
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
    const memUsage = raw.memory_stats?.usage || 0;
    const memCache = raw.memory_stats?.stats?.cache || raw.memory_stats?.stats?.inactive_file || 0;
    const memActual = memUsage - memCache;
    const memLimit = raw.memory_stats?.limit || 0;
    const memPercent = memLimit > 0 ? (memActual / memLimit) * 100 : 0;

    // ── Network I/O ────────────────────────────────────────────
    let netRx = 0, netTx = 0, netRxPackets = 0, netTxPackets = 0;
    let netRxDropped = 0, netTxDropped = 0, netRxErrors = 0, netTxErrors = 0;
    const networkInterfaces: Record<string, any> = {};
    if (raw.networks) {
      for (const [ifaceName, iface] of Object.entries(raw.networks) as [string, any][]) {
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
    if (raw.blkio_stats?.io_service_bytes_recursive) {
      for (const entry of raw.blkio_stats.io_service_bytes_recursive) {
        if (entry.op === "read" || entry.op === "Read") blockRead += entry.value || 0;
        if (entry.op === "write" || entry.op === "Write") blockWrite += entry.value || 0;
      }
    }

    // ── PIDs ───────────────────────────────────────────────────
    const pids = raw.pids_stats?.current || 0;

    // ── Memory Detail ─────────────────────────────────────────
    const memoryDetail = {
      rss: raw.memory_stats?.stats?.rss || 0,
      cache: memCache,
      swap: raw.memory_stats?.stats?.swap || 0,
      maxUsage: raw.memory_stats?.max_usage || 0,
      activeAnon: raw.memory_stats?.stats?.active_anon || 0,
      inactiveAnon: raw.memory_stats?.stats?.inactive_anon || 0,
      pgfault: raw.memory_stats?.stats?.pgfault || 0,
      pgmajfault: raw.memory_stats?.stats?.pgmajfault || 0,
    };

    // ── CPU Throttling ────────────────────────────────────────
    const throttling = raw.cpu_stats?.throttling_data || {};
    const cpuThrottling = {
      periods: throttling.periods || 0,
      throttledPeriods: throttling.throttled_periods || 0,
      throttledTimeNs: throttling.throttled_time || 0,
    };

    // ── Container Metadata ────────────────────────────────────
    const command = container.Command || "";
    const ports = (container.Ports || []).map((p: any) => ({
      ip: p.IP || "",
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort,
      type: p.Type,
    }));
    const mounts = (container.Mounts || []).map((m: any) => ({
      type: m.Type,
      name: m.Name || "",
      source: m.Source,
      destination: m.Destination,
      mode: m.Mode || "rw",
      rw: m.RW ?? true,
    }));
    const labels = container.Labels || {};
    const name = (container.Names?.[0] || "unknown").replace(/^\//, "");

    return {
      id: container.Id.substring(0, 12),
      name,
      image: container.Image,
      state: container.State,
      status: container.Status,
      created: container.Created,
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

  /**
   * Get Docker system-level information and disk usage for a device.


   */
  static async getSystemInfo(deviceId: any) {
    const devices = getDockerDevices();

    if (deviceId) {
      const target = devices.find((d: any) => d.id === deviceId);
      if (!target) throw new Error(`Unknown Docker device: ${deviceId}`);
      return DockerStatsService._getSystemInfoForDevice(target.id, target.device);
    }

    // Return system info for all Docker hosts
    const results = await Promise.allSettled(
      devices.map((t: any) =>
        DockerStatsService._getSystemInfoForDevice(t.id, t.device)
          .then((info: any) => ({ deviceId: t.id, deviceName: t.device.name, ...info })),
      ),
    );

    return results
      .filter((r: any) => r.status === "fulfilled")
      .map((r: any) => r.value);
  }

  /**
   * Get system info for a single Docker host. Uses per-device cache.


   */
  static async _getSystemInfoForDevice(deviceId: any, device: any) {
    const cached = systemCacheMap.get(deviceId);
    if (cached && Date.now() - cached.fetchedAt < SYSTEM_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const [infoBody, dfBody] = await Promise.all([
        DockerStatsService._dockerGet(device, "/info", SYSTEM_REQUEST_TIMEOUT_MS),
        DockerStatsService._dockerGet(device, "/system/df", SYSTEM_REQUEST_TIMEOUT_MS),
      ]);

      const info = JSON.parse(infoBody as string);
      const df = JSON.parse(dfBody as string);

      // ── Image disk usage ────────────────────────────────────
      const images = (df.Images || []).map((image: any) => ({
        id: image.Id?.substring(0, 12) || "unknown",
        tags: image.RepoTags || [],
        size: image.Size || 0,
        sharedSize: image.SharedSize || 0,
        created: image.Created,
        containers: image.Containers || 0,
      }));

      const totalImageSize = images.reduce((sum: any, image: any) => sum + image.size, 0);
      const totalImageShared = images.reduce((sum: any, image: any) => sum + image.sharedSize, 0);

      // ── Volume disk usage ───────────────────────────────────
      const volumes = (df.Volumes || []).map((vol: any) => ({
        name: vol.Name,
        driver: vol.Driver,
        size: vol.UsageData?.Size || 0,
        refCount: vol.UsageData?.RefCount || 0,
      }));

      const totalVolumeSize = volumes.reduce((sum: any, vol: any) => sum + vol.size, 0);

      // ── Build cache disk usage ──────────────────────────────
      const buildCache = df.BuildCache || [];
      const totalBuildCacheSize = buildCache.reduce(
        (sum: any, entry: any) => sum + (entry.Size || 0),
        0,
      );

      // ── Container disk usage ────────────────────────────────
      const containersDf = (df.Containers || []).map((c: any) => ({
        id: c.Id?.substring(0, 12) || "unknown",
        names: c.Names || [],
        sizeRw: c.SizeRw || 0,
        sizeRootFs: c.SizeRootFs || 0,
        state: c.State,
      }));

      const totalContainerRw = containersDf.reduce(
        (sum: number, c: any) => sum + c.sizeRw,
        0,
      );

      // ── Host-level disk stats ──────────────────────────────
      // Only available for the local host (Unix socket)
      let hostDisk: any = null;
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
        } catch (dfErr: any) {
          logger.warn(`[DockerStats:${deviceId}] Host disk stats failed: ${dfErr.message}`);
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
            items: images.sort((a: any, b: any) => b.size - a.size).slice(0, 20),
          },
          volumes: {
            count: volumes.length,
            totalSize: totalVolumeSize,
            items: volumes.sort((a: any, b: any) => b.size - a.size),
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
    } catch (error: any) {
      logger.error(`[DockerStats:${deviceId}] System info failed: ${error.message}`);
      const stale = systemCacheMap.get(deviceId);
      if (stale) return stale.data;
      throw error;
    }
  }

  // ── Transport Layer ────────────────────────────────────────────

  /**
   * HTTP GET helper for the Docker Engine API.
   * Dispatches to Unix socket or TCP based on device.dockerApi.


   */
  static _dockerGet(device: any, path: string, timeoutMs: any = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve: any, reject: any) => {
      const transport = parseTransport(device.dockerApi, path);

      const req = http.request(
        {
          ...transport,
          method: "GET",
          headers: { Accept: "application/json" },
        },
        (res: any) => {
          let body = "";
          res.on("data", (chunk: any) => (body += chunk));
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

  /**
   * HTTP POST/DELETE helper for Docker Engine API (container actions).


   * @param {{ timeout?: number }} [opts]
   * @returns {Promise<{ statusCode: number, body: string }>}
   */
  static dockerRequest(device: any, method: string, path: string, { timeout = 30_000 }: any = {}) {
    return new Promise((resolve: any, reject: any) => {
      const transport = parseTransport(device.dockerApi, path);

      const req = http.request(
        {
          ...transport,
          method,
          headers: { "Content-Type": "application/json" },
        },
        (res: any) => {
          let body = "";
          res.on("data", (chunk: any) => (body += chunk));
          res.on("end", () => resolve({ statusCode: res.statusCode, body }));
        },
      );

      req.setTimeout(timeout, () => {
        req.destroy(new Error(`Docker API timeout after ${timeout}ms`));
      });

      req.on("error", reject);
      req.end();
    });
  }

  /**
   * Public wrapper for _dockerGet — read-only Docker Engine API calls.


   */
  static dockerGet(device: any, path: string, timeoutMs?: number) {
    return DockerStatsService._dockerGet(device, path, timeoutMs);
  }
}

// ── Auto-start collector on import ────────────────────────────────
DockerStatsService.startCollector();
