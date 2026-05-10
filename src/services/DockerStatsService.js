// ============================================================
// API — Docker Stats Service
// ============================================================
// Queries the Docker Engine API over the mounted Unix socket
// to collect per-container resource usage: CPU %, memory,
// network I/O, and block I/O.
//
// Uses one-shot stats (stream=false, one-shot=true) for instant
// parallel responses. CPU deltas are computed internally by
// caching the previous raw counters between collection cycles,
// since one-shot mode returns zeroed precpu_stats.
//
// Results are cached with a short TTL to avoid hammering
// the Docker API on rapid client refreshes.
//
// Also maintains a ring buffer of historical snapshots
// (every 5 seconds, up to 5 minutes) for live sparkline charts.
// ============================================================

import http from "http";
import { execSync } from "child_process";
import os from "os";
import logger from "../utils/logger.js";

const DOCKER_SOCKET = "/var/run/docker.sock";
const STATS_CACHE_TTL_MS = 10_000;  // 10s cache for container stats
const SYSTEM_CACHE_TTL_MS = 60_000; // 60s cache for system info (/system/df is expensive)
const REQUEST_TIMEOUT_MS = 8_000;
const SYSTEM_REQUEST_TIMEOUT_MS = 30_000; // /system/df traverses every layer

// ── Ring Buffer Config ───────────────────────────────────────────
const HISTORY_INTERVAL_MS = 5_000;      // sample every 5 seconds
const HISTORY_MAX_SAMPLES = 60;         // retain 5 minutes (60 × 5s)

/** @type {{ data: any, fetchedAt: number } | null} */
let cachedStats = null;

/** @type {{ data: any, fetchedAt: number } | null} */
let cachedSystemInfo = null;

/**
 * Previous raw CPU counters keyed by container ID.
 * Used to compute CPU deltas since one-shot mode returns zeroed precpu_stats.
 * @type {Map<string, { cpuTotal: number, systemTotal: number }>}
 */
const previousCpuCounters = new Map();

/**
 * Ring buffer of snapshots.
 * Each entry: { timestamp: string, containers: { [name]: { cpu, memory, blockIO } } }
 * @type {Array<object>}
 */
const history = [];

/** Timer reference for cleanup on shutdown. */
let collectorTimer = null;

export default class DockerStatsService {
  /**
   * Get resource stats for all containers (running and stopped).
   * Returns cached data if within TTL, otherwise fetches fresh.
   * Stopped containers return zeroed metrics.
   * @returns {Promise<object[]>}
   */
  static async getAll() {
    if (cachedStats && Date.now() - cachedStats.fetchedAt < STATS_CACHE_TTL_MS) {
      return cachedStats.data;
    }

    try {
      const containers = await DockerStatsService._listContainers();
      const stats = await Promise.all(
        containers.map((c) => {
          // Skip stats API call for non-running containers (would fail)
          if (c.State !== "running") {
            return DockerStatsService._buildStoppedSkeleton(c);
          }
          return DockerStatsService._getContainerStats(c);
        }),
      );

      // Filter out nulls (failed stats) and sort by name
      const result = stats.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));

      // Prune stale entries from previousCpuCounters for containers that no longer exist
      const activeIds = new Set(containers.map((c) => c.Id));
      for (const id of previousCpuCounters.keys()) {
        if (!activeIds.has(id)) previousCpuCounters.delete(id);
      }

      cachedStats = { data: result, fetchedAt: Date.now() };
      return result;
    } catch (err) {
      logger.error(`[DockerStats] Failed to collect stats: ${err.message}`);
      // Return stale cache if available
      if (cachedStats) return cachedStats.data;
      throw err;
    }
  }

  /**
   * Get the historical time-series ring buffer.
   * Returns the full array of snapshots (oldest first).
   * @returns {Array<object>}
   */
  static getHistory() {
    return history;
  }

  /**
   * Invalidate the stats cache.
   */
  static invalidate() {
    cachedStats = null;
    cachedSystemInfo = null;
  }

  /**
   * Start the background collector that populates the ring buffer.
   * Called automatically on module load.
   */
  static startCollector() {
    if (collectorTimer) return; // already running

    // Collect immediately, then at intervals
    DockerStatsService._collectSnapshot();
    collectorTimer = setInterval(
      () => DockerStatsService._collectSnapshot(),
      HISTORY_INTERVAL_MS,
    );

    logger.info(`[DockerStats] Ring buffer collector started (every ${HISTORY_INTERVAL_MS / 1000}s, ${HISTORY_MAX_SAMPLES} max samples)`);
  }

  /**
   * Stop the background collector.
   */
  static stopCollector() {
    if (collectorTimer) {
      clearInterval(collectorTimer);
      collectorTimer = null;
    }
  }

  /**
   * Collect a single snapshot and push it into the ring buffer.
   * @private
   */
  static async _collectSnapshot() {
    try {
      const stats = await DockerStatsService.getAll();

      const snapshot = {
        timestamp: new Date().toISOString(),
        containers: {},
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

      history.push(snapshot);

      // Trim ring buffer
      while (history.length > HISTORY_MAX_SAMPLES) {
        history.shift();
      }
    } catch (err) {
      // Silently ignore — Docker socket may be unavailable
      logger.warn(`[DockerStats] Snapshot collection failed: ${err.message}`);
    }
  }

  /**
   * List all containers (running + stopped) via Docker Engine API.
   * @returns {Promise<object[]>}
   */
  static async _listContainers() {
    const body = await DockerStatsService._dockerGet(
      "/containers/json?all=true",
    );
    return JSON.parse(body);
  }

  /**
   * Build a zeroed-stats skeleton for a stopped/exited container.
   * Mirrors the shape returned by _parseStats so the client doesn't break.
   * @param {object} container - Container object from /containers/json
   * @returns {object}
   */
  static _buildStoppedSkeleton(container) {
    const name = (container.Names?.[0] || "unknown").replace(/^\//, "");
    const command = container.Command || "";
    const ports = (container.Ports || []).map((p) => ({
      ip: p.IP || "",
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort,
      type: p.Type,
    }));
    const mounts = (container.Mounts || []).map((m) => ({
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
   * Get one-shot stats for a single container.
   * one-shot=true returns instantly (no ~1s sampling delay).
   * CPU deltas are computed from our own cached previous counters.
   * @param {object} container - Container object from /containers/json
   * @returns {Promise<object|null>}
   */
  static async _getContainerStats(container) {
    try {
      const body = await DockerStatsService._dockerGet(
        `/containers/${container.Id}/stats?stream=false&one-shot=true`,
      );
      const raw = JSON.parse(body);

      return DockerStatsService._parseStats(container, raw);
    } catch (err) {
      logger.warn(
        `[DockerStats] Failed to get stats for ${container.Names?.[0]}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Parse raw Docker stats into a clean, displayable format.
   * Uses cached previous counters to compute CPU deltas since
   * one-shot mode returns zeroed precpu_stats.
   * @param {object} container
   * @param {object} raw - Raw stats from Docker API
   * @returns {object}
   */
  static _parseStats(container, raw) {
    // ── CPU (self-tracked deltas) ──────────────────────────────
    const currentCpuTotal = raw.cpu_stats?.cpu_usage?.total_usage || 0;
    const currentSystemTotal = raw.cpu_stats?.system_cpu_usage || 0;
    const numCpus =
      raw.cpu_stats?.online_cpus ||
      raw.cpu_stats?.cpu_usage?.percpu_usage?.length ||
      1;

    const prev = previousCpuCounters.get(container.Id);

    let cpuPercent = 0;
    if (prev) {
      const cpuDelta = currentCpuTotal - prev.cpuTotal;
      const systemDelta = currentSystemTotal - prev.systemTotal;
      if (systemDelta > 0 && cpuDelta > 0) {
        cpuPercent = (cpuDelta / systemDelta) * numCpus * 100;
      }
    }

    // Store current counters for next cycle's delta
    previousCpuCounters.set(container.Id, {
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
    let netRx = 0;
    let netTx = 0;
    let netRxPackets = 0;
    let netTxPackets = 0;
    let netRxDropped = 0;
    let netTxDropped = 0;
    let netRxErrors = 0;
    let netTxErrors = 0;
    const networkInterfaces = {};
    if (raw.networks) {
      for (const [ifaceName, iface] of Object.entries(raw.networks)) {
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
    let blockRead = 0;
    let blockWrite = 0;
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
    const ports = (container.Ports || []).map((p) => ({
      ip: p.IP || "",
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort,
      type: p.Type,
    }));
    const mounts = (container.Mounts || []).map((m) => ({
      type: m.Type,
      name: m.Name || "",
      source: m.Source,
      destination: m.Destination,
      mode: m.Mode || "rw",
      rw: m.RW ?? true,
    }));
    const labels = container.Labels || {};

    // ── Container name cleanup ─────────────────────────────────
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
        rx: netRx,
        tx: netTx,
        rxPackets: netRxPackets,
        txPackets: netTxPackets,
        rxDropped: netRxDropped,
        txDropped: netTxDropped,
        rxErrors: netRxErrors,
        txErrors: netTxErrors,
        interfaces: networkInterfaces,
      },
      blockIO: {
        read: blockRead,
        write: blockWrite,
      },
      pids,
    };
  }

  /**
   * Get Docker system-level information and disk usage.
   * Includes images, containers, volumes, and build cache sizes.
   * @returns {Promise<object>}
   */
  static async getSystemInfo() {
    // Return cached data if within TTL
    if (cachedSystemInfo && Date.now() - cachedSystemInfo.fetchedAt < SYSTEM_CACHE_TTL_MS) {
      return cachedSystemInfo.data;
    }

    try {
      const [infoBody, dfBody] = await Promise.all([
        DockerStatsService._dockerGet("/info", SYSTEM_REQUEST_TIMEOUT_MS),
        DockerStatsService._dockerGet("/system/df", SYSTEM_REQUEST_TIMEOUT_MS),
      ]);

      const info = JSON.parse(infoBody);
      const df = JSON.parse(dfBody);

      // ── Image disk usage ────────────────────────────────────
      const images = (df.Images || []).map((img) => ({
        id: img.Id?.substring(0, 12) || "unknown",
        tags: img.RepoTags || [],
        size: img.Size || 0,
        sharedSize: img.SharedSize || 0,
        created: img.Created,
        containers: img.Containers || 0,
      }));

      const totalImageSize = images.reduce((sum, img) => sum + img.size, 0);
      const totalImageShared = images.reduce((sum, img) => sum + img.sharedSize, 0);

      // ── Volume disk usage ───────────────────────────────────
      const volumes = (df.Volumes || []).map((vol) => ({
        name: vol.Name,
        driver: vol.Driver,
        size: vol.UsageData?.Size || 0,
        refCount: vol.UsageData?.RefCount || 0,
      }));

      const totalVolumeSize = volumes.reduce((sum, vol) => sum + vol.size, 0);

      // ── Build cache disk usage ──────────────────────────────
      const buildCache = df.BuildCache || [];
      const totalBuildCacheSize = buildCache.reduce(
        (sum, entry) => sum + (entry.Size || 0),
        0,
      );

      // ── Container disk usage ────────────────────────────────
      const containersDf = (df.Containers || []).map((c) => ({
        id: c.Id?.substring(0, 12) || "unknown",
        names: c.Names || [],
        sizeRw: c.SizeRw || 0,       // writable layer
        sizeRootFs: c.SizeRootFs || 0, // total (image + writable)
        state: c.State,
      }));

      const totalContainerRw = containersDf.reduce(
        (sum, c) => sum + c.sizeRw,
        0,
      );

      // ── Host-level disk stats ──────────────────────────────
      let hostDisk = null;
      try {
        const dfOutput = execSync("df -B1 / | tail -1", { encoding: "utf8", timeout: 3000 });
        const parts = dfOutput.trim().split(/\s+/);
        // df -B1 columns: Filesystem  1B-blocks  Used  Available  Use%  Mounted
        if (parts.length >= 5) {
          const total = parseInt(parts[1], 10) || 0;
          const used = parseInt(parts[2], 10) || 0;
          const available = parseInt(parts[3], 10) || 0;
          const percent = total > 0 ? Math.round((used / total) * 10000) / 100 : 0;
          hostDisk = { total, used, available, percent };
        }
      } catch (dfErr) {
        logger.warn(`[DockerStats] Host disk stats failed: ${dfErr.message}`);
      }

      const result = {
        // System overview
        serverVersion: info.ServerVersion,
        os: info.OperatingSystem,
        architecture: info.Architecture,
        totalMemory: info.MemTotal || os.totalmem(),
        cpus: info.NCPU || os.cpus().length,
        containersRunning: info.ContainersRunning,
        containersStopped: info.ContainersStopped,
        containersPaused: info.ContainersPaused,
        containersTotal: info.Containers,
        // Host-level disk (entire filesystem)
        hostDisk,
        // Docker-specific disk usage breakdown
        disk: {
          images: {
            count: images.length,
            totalSize: totalImageSize,
            sharedSize: totalImageShared,
            items: images.sort((a, b) => b.size - a.size).slice(0, 20),
          },
          volumes: {
            count: volumes.length,
            totalSize: totalVolumeSize,
            items: volumes.sort((a, b) => b.size - a.size),
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

      cachedSystemInfo = { data: result, fetchedAt: Date.now() };
      return result;
    } catch (err) {
      logger.error(`[DockerStats] System info failed: ${err.message}`);
      // Return stale cache if available
      if (cachedSystemInfo) return cachedSystemInfo.data;
      throw err;
    }
  }

  /**
   * HTTP GET helper for the Docker Engine API via Unix socket.
   * @param {string} path
   * @returns {Promise<string>}
   */
  static _dockerGet(path, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: DOCKER_SOCKET,
          path,
          method: "GET",
          headers: { Accept: "application/json" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
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
}

// ── Auto-start collector on import ────────────────────────────────
DockerStatsService.startCollector();
