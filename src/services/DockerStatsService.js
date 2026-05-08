// ============================================================
// API — Docker Stats Service
// ============================================================
// Queries the Docker Engine API over the mounted Unix socket
// to collect per-container resource usage: CPU %, memory,
// network I/O, and block I/O.
//
// Uses one-shot stats (stream=false) for each container.
// Results are cached with a short TTL to avoid hammering
// the Docker API on rapid client refreshes.
//
// Also maintains a ring buffer of historical snapshots
// (every 5 seconds, up to 5 minutes) for live sparkline charts.
// ============================================================

import http from "http";
import logger from "../utils/logger.js";

const DOCKER_SOCKET = "/var/run/docker.sock";
const STATS_CACHE_TTL_MS = 10_000; // 10s cache
const REQUEST_TIMEOUT_MS = 8_000;

// ── Ring Buffer Config ───────────────────────────────────────────
const HISTORY_INTERVAL_MS = 5_000;      // sample every 5 seconds
const HISTORY_MAX_SAMPLES = 60;         // retain 5 minutes (60 × 5s)

/** @type {{ data: any, fetchedAt: number } | null} */
let cachedStats = null;

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
   * Get resource stats for all running containers.
   * Returns cached data if within TTL, otherwise fetches fresh.
   * @returns {Promise<object[]>}
   */
  static async getAll() {
    if (cachedStats && Date.now() - cachedStats.fetchedAt < STATS_CACHE_TTL_MS) {
      return cachedStats.data;
    }

    try {
      const containers = await DockerStatsService._listContainers();
      const stats = await Promise.all(
        containers.map((c) => DockerStatsService._getContainerStats(c)),
      );

      // Filter out nulls (failed stats) and sort by name
      const result = stats.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));

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
   * List running containers via Docker Engine API.
   * @returns {Promise<object[]>}
   */
  static async _listContainers() {
    const body = await DockerStatsService._dockerGet(
      "/containers/json?all=false",
    );
    return JSON.parse(body);
  }

  /**
   * Get one-shot stats for a single container.
   * stream=false makes the API return immediately instead of streaming.
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
   * @param {object} container
   * @param {object} raw - Raw stats from Docker API
   * @returns {object}
   */
  static _parseStats(container, raw) {
    // ── CPU ────────────────────────────────────────────────────
    const cpuDelta =
      (raw.cpu_stats?.cpu_usage?.total_usage || 0) -
      (raw.precpu_stats?.cpu_usage?.total_usage || 0);
    const systemDelta =
      (raw.cpu_stats?.system_cpu_usage || 0) -
      (raw.precpu_stats?.system_cpu_usage || 0);
    const numCpus =
      raw.cpu_stats?.online_cpus ||
      raw.cpu_stats?.cpu_usage?.percpu_usage?.length ||
      1;

    let cpuPercent = 0;
    if (systemDelta > 0 && cpuDelta > 0) {
      cpuPercent = (cpuDelta / systemDelta) * numCpus * 100;
    }

    // ── Memory ─────────────────────────────────────────────────
    const memUsage = raw.memory_stats?.usage || 0;
    const memCache = raw.memory_stats?.stats?.cache || raw.memory_stats?.stats?.inactive_file || 0;
    const memActual = memUsage - memCache;
    const memLimit = raw.memory_stats?.limit || 0;
    const memPercent = memLimit > 0 ? (memActual / memLimit) * 100 : 0;

    // ── Network I/O ────────────────────────────────────────────
    let netRx = 0;
    let netTx = 0;
    if (raw.networks) {
      for (const iface of Object.values(raw.networks)) {
        netRx += iface.rx_bytes || 0;
        netTx += iface.tx_bytes || 0;
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

    // ── Container name cleanup ─────────────────────────────────
    const name = (container.Names?.[0] || "unknown").replace(/^\//, "");

    return {
      id: container.Id.substring(0, 12),
      name,
      image: container.Image,
      state: container.State,
      status: container.Status,
      created: container.Created,
      cpu: {
        percent: Math.round(cpuPercent * 100) / 100,
        cores: numCpus,
      },
      memory: {
        used: memActual,
        limit: memLimit,
        percent: Math.round(memPercent * 100) / 100,
      },
      network: {
        rx: netRx,
        tx: netTx,
      },
      blockIO: {
        read: blockRead,
        write: blockWrite,
      },
      pids,
    };
  }

  /**
   * HTTP GET helper for the Docker Engine API via Unix socket.
   * @param {string} path
   * @returns {Promise<string>}
   */
  static _dockerGet(path) {
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

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error("Docker API timeout"));
      });

      req.on("error", reject);
      req.end();
    });
  }
}

// ── Auto-start collector on import ────────────────────────────────
DockerStatsService.startCollector();
