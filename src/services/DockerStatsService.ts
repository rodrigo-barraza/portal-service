import logger from "../utils/logger.ts";
import { getErrorMessage, seconds } from "@rodrigo-barraza/utilities-library";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import { DEVICES } from "../config.ts";
import ContainerMetricsService, {
  PERSIST_INTERVAL_MS,
} from "./ContainerMetricsService.ts";
import type {
  DeviceEntry,
  DeviceSpecs,
  ContainerStats,
  ContainerSnapshot,
} from "../types.ts";
import { createDedupedTtlCache } from "../utils/cache.ts";
import { DockerClient } from "../wrappers/DockerClient.ts";
import { DockerStatsParser } from "./docker/DockerStatsParser.ts";
import { DockerSystemHelper } from "./docker/DockerSystemHelper.ts";

const STATS_CACHE_TTL_MS = 10_000;
// System info fans out to Docker's /system/df — a disk-usage walk of every
// image/volume that can take 30s+ on the NAS — so it is cached and
// concurrent callers share one in-flight fetch.
const SYSTEM_INFO_CACHE_TTL_MS = 60_000;
const SYSTEM_REQUEST_TIMEOUT_MS = seconds(30);
// Hardware specs come from the cheap /info call only (no /system/df walk)
// and change rarely.
const DEVICE_SPECS_CACHE_TTL_MS = 300_000;
const HISTORY_INTERVAL_MS = 5_000;
const HISTORY_MAX_SAMPLES = 60;

// Stale-on-error: a failed collection keeps serving the last good stats.
const statsCache = createDedupedTtlCache({ serveStaleOnError: true });
const systemInfoCache = createDedupedTtlCache({ serveStaleOnError: true });
const deviceSpecsCache = createDedupedTtlCache({ serveStaleOnError: true });

const cpuCounterMap = new Map<
  string,
  Map<string, { cpuTotal: number; systemTotal: number }>
>();
const historyMap = new Map<string, ContainerSnapshot[]>();
const lastPersistMap = new Map<string, number>();
const collectingDevices = new Set<string>();
let collectorTimer: ReturnType<typeof setInterval> | null = null;

function getDockerDevices(): Array<{ id: string; device: DeviceEntry }> {
  return Object.entries(DEVICES)
    .filter(([, deviceEntry]) => deviceEntry.dockerApi)
    .map(([id, deviceEntry]) => ({ id, device: deviceEntry }));
}

function byName(first: ContainerStats, second: ContainerStats): number {
  return first.name.localeCompare(second.name);
}

export default class DockerStatsService {
  public static async getAll(deviceId?: string): Promise<ContainerStats[]> {
    const devices = getDockerDevices();
    const targets = deviceId
      ? devices.filter((deviceEntry) => deviceEntry.id === deviceId)
      : devices;

    const results = await Promise.all(
      targets.map((target) =>
        DockerStatsService._getAllForDevice(target.id, target.device),
      ),
    );
    return results.flat().sort(byName);
  }

  private static async _getAllForDevice(
    deviceId: string,
    deviceEntry: DeviceEntry,
  ): Promise<ContainerStats[]> {
    try {
      return await statsCache.get(deviceId, STATS_CACHE_TTL_MS, () =>
        DockerStatsService._fetchAllForDevice(deviceId, deviceEntry),
      );
    } catch {
      // No stale data available for this device — degrade to an empty list.
      return [];
    }
  }

  private static async _fetchAllForDevice(
    deviceId: string,
    deviceEntry: DeviceEntry,
  ): Promise<ContainerStats[]> {
    try {
      const containers = await DockerClient.dockerGetJson<
        Record<string, unknown>[]
      >(deviceEntry, "/containers/json?all=true");

      if (!cpuCounterMap.has(deviceId)) {
        cpuCounterMap.set(deviceId, new Map());
      }
      const deviceCounters = cpuCounterMap.get(deviceId)!;

      const stats = await Promise.all(
        containers.map(
          async (containerEntry): Promise<ContainerStats | null> => {
            if (containerEntry.State !== "running") {
              return DockerStatsParser.buildStoppedSkeleton(
                containerEntry,
                deviceId,
              );
            }

            const containerId = String(containerEntry.Id);
            try {
              const rawStats = await DockerClient.dockerGetJson<
                Record<string, unknown>
              >(
                deviceEntry,
                `/containers/${containerId}/stats?stream=false&one-shot=true`,
              );

              const parsedStats = DockerStatsParser.parseStats(
                containerEntry,
                rawStats,
                deviceId,
                deviceCounters.get(containerId),
              );

              // CPU% is a delta against this container's previous sample
              const rawCpuStats = rawStats.cpu_stats as
                Record<string, unknown> | undefined;
              const rawCpuUsage = rawCpuStats?.cpu_usage as
                Record<string, unknown> | undefined;
              deviceCounters.set(containerId, {
                cpuTotal: (rawCpuUsage?.total_usage as number) || 0,
                systemTotal: (rawCpuStats?.system_cpu_usage as number) || 0,
              });

              return parsedStats;
            } catch (error: unknown) {
              logger.warn(
                `[DockerStats:${deviceId}] Failed to get stats for ${(containerEntry.Names as string[] | undefined)?.[0]}: ${getErrorMessage(error)}`,
              );
              return null;
            }
          },
        ),
      );

      const activeIds = new Set(
        containers.map((containerEntry) => String(containerEntry.Id)),
      );
      for (const id of deviceCounters.keys()) {
        if (!activeIds.has(id)) deviceCounters.delete(id);
      }

      return stats
        .filter((entry): entry is ContainerStats => entry !== null)
        .sort(byName);
    } catch (error: unknown) {
      logger.error(
        `[DockerStats:${deviceId}] Failed to collect stats: ${getErrorMessage(error)}`,
      );
      throw error;
    }
  }

  public static getHistory(
    deviceId?: string,
  ): Record<string, ContainerSnapshot[]> {
    if (deviceId) {
      return { [deviceId]: historyMap.get(deviceId) || [] };
    }
    return Object.fromEntries(historyMap);
  }

  public static invalidate(deviceId?: string): void {
    if (deviceId) {
      statsCache.delete(deviceId);
      systemInfoCache.delete(deviceId);
    } else {
      statsCache.clear();
      systemInfoCache.clear();
    }
  }

  /** Start the ring-buffer collector; index.ts stops it on shutdown. */
  public static startCollector(): void {
    if (collectorTimer) return;

    void DockerStatsService._collectSnapshot();
    collectorTimer = setInterval(
      () => void DockerStatsService._collectSnapshot(),
      HISTORY_INTERVAL_MS,
    );

    logger.info(
      `[DockerStats] Ring buffer collector started — ${getDockerDevices().length} Docker host(s) (every ${HISTORY_INTERVAL_MS / 1000}s, ${HISTORY_MAX_SAMPLES} max samples)`,
    );
  }

  public static stopCollector(): void {
    if (collectorTimer) {
      clearInterval(collectorTimer);
      collectorTimer = null;
    }
  }

  public static async _collectSnapshot(): Promise<void> {
    await Promise.all(
      getDockerDevices().map(({ id, device }) =>
        DockerStatsService._collectDeviceSnapshot(id, device),
      ),
    );
  }

  /**
   * Sample one device into its ring buffer. Always a fresh fetch (and it
   * refreshes the route cache): reading through the 10s cache on a 5s
   * cadence recorded every other sample as a duplicate of the last one.
   * A device still busy with the previous tick (a stalled NAS) is skipped
   * rather than stacking another full fan-out on top of it.
   */
  public static async _collectDeviceSnapshot(
    deviceId: string,
    device: DeviceEntry,
  ): Promise<void> {
    if (collectingDevices.has(deviceId)) return;
    collectingDevices.add(deviceId);

    try {
      const stats = await DockerStatsService._fetchAllForDevice(
        deviceId,
        device,
      );
      statsCache.set(deviceId, stats);

      const snapshot: ContainerSnapshot = {
        timestamp: new Date().toISOString(),
        containers: {},
      };
      for (const containerStats of stats) {
        snapshot.containers[containerStats.name] = {
          cpu: containerStats.cpu.percent,
          memoryUsed: containerStats.memory.used,
          memoryLimit: containerStats.memory.limit,
          memoryPercent: containerStats.memory.percent,
          blockRead: containerStats.blockIO.read,
          blockWrite: containerStats.blockIO.write,
          netRx: containerStats.network.rx,
          netTx: containerStats.network.tx,
          pids: containerStats.pids,
        };
      }

      const history = historyMap.get(deviceId) ?? [];
      history.push(snapshot);
      if (history.length > HISTORY_MAX_SAMPLES)
        history.splice(0, history.length - HISTORY_MAX_SAMPLES);
      historyMap.set(deviceId, history);

      const now = Date.now();
      if (now - (lastPersistMap.get(deviceId) || 0) >= PERSIST_INTERVAL_MS) {
        lastPersistMap.set(deviceId, now);
        ContainerMetricsService.persistSnapshot(deviceId, stats).catch(
          (error: unknown) => {
            logger.warn(
              `[DockerStats:${deviceId}] Metrics persist failed: ${getErrorMessage(error)}`,
            );
          },
        );
      }
    } catch (error: unknown) {
      logger.warn(
        `[DockerStats:${deviceId}] Snapshot failed: ${getErrorMessage(error)}`,
      );
    } finally {
      collectingDevices.delete(deviceId);
    }
  }

  /**
   * Live hardware specs per Docker-reachable device, keyed by device id.
   * Devices without a reachable dockerApi endpoint are absent from the result.
   */
  public static async getDeviceSpecs(): Promise<Record<string, DeviceSpecs>> {
    const settled = await Promise.allSettled(
      getDockerDevices().map(async ({ id, device }) => {
        const specs = await deviceSpecsCache.get(
          id,
          DEVICE_SPECS_CACHE_TTL_MS,
          () => DockerSystemHelper.getSpecsForDevice(device),
        );
        return [id, specs] as const;
      }),
    );

    const specsByDevice: Record<string, DeviceSpecs> = {};
    for (const result of settled) {
      if (result.status === "fulfilled") {
        specsByDevice[result.value[0]] = result.value[1];
      }
    }
    return specsByDevice;
  }

  public static getSystemInfo(deviceId?: string): Promise<unknown> {
    return systemInfoCache.get(
      deviceId || "__all__",
      SYSTEM_INFO_CACHE_TTL_MS,
      () => DockerStatsService._fetchSystemInfo(deviceId),
    );
  }

  private static async _fetchSystemInfo(deviceId?: string) {
    const devices = getDockerDevices();

    if (deviceId) {
      const target = devices.find((deviceEntry) => deviceEntry.id === deviceId);
      if (!target)
        throw new HttpError(`Unknown Docker device: ${deviceId}`, 404);
      return DockerSystemHelper.getSystemInfoForDevice(
        target.id,
        target.device,
        SYSTEM_REQUEST_TIMEOUT_MS,
      );
    }

    const results = await Promise.allSettled(
      devices.map(async (deviceTarget) => ({
        deviceName: deviceTarget.device.name,
        ...(await DockerSystemHelper.getSystemInfoForDevice(
          deviceTarget.id,
          deviceTarget.device,
          SYSTEM_REQUEST_TIMEOUT_MS,
        )),
      })),
    );

    return results
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Record<string, unknown> & { deviceName: string }
        > => result.status === "fulfilled",
      )
      .map((result) => result.value);
  }
}
