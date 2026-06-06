import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { DEVICES } from "../config.ts";
import ContainerMetricsService from "./ContainerMetricsService.ts";
import type {
  DockerActionResponse,
  DeviceEntry,
  ContainerStats,
  ContainerSnapshot,
} from "../types.ts";
import { DockerClient } from "../wrappers/DockerClient.ts";
import { DockerStatsParser } from "./docker/DockerStatsParser.ts";
import { DockerSystemHelper } from "./docker/DockerSystemHelper.ts";

const STATS_CACHE_TTL_MS = 10_000;
const SYSTEM_CACHE_TTL_MS = 60_000;
const SYSTEM_REQUEST_TIMEOUT_MS = 30_000;
const HISTORY_INTERVAL_MS = 5_000;
const HISTORY_MAX_SAMPLES = 60;

const statsCacheMap = new Map<string, { data: ContainerStats[]; fetchedAt: number }>();
const systemCacheMap = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
const cpuCounterMap = new Map<string, Map<string, { cpuTotal: number; systemTotal: number }>>();
const historyMap = new Map<string, ContainerSnapshot[]>();
const lastPersistMap = new Map<string, number>();

function getDockerDevices(): Array<{ id: string; device: DeviceEntry }> {
  return Object.entries(DEVICES)
    .filter(([, deviceEntry]) => deviceEntry.dockerApi)
    .map(([id, deviceEntry]) => ({ id, device: deviceEntry }));
}

export default class DockerStatsService {
  public static async getAll(deviceId?: string): Promise<ContainerStats[]> {
    const devices = getDockerDevices();
    const targets = deviceId
      ? devices.filter((deviceEntry) => deviceEntry.id === deviceId)
      : devices;

    if (targets.length === 0) return [];

    const results = await Promise.allSettled(
      targets.map((target) => DockerStatsService._getAllForDevice(target.id, target.device))
    );

    const combined: ContainerStats[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        combined.push(...result.value);
      }
    }

    return combined.sort((firstContainer, secondContainer) => firstContainer.name.localeCompare(secondContainer.name));
  }

  public static async _getAllForDevice(
    deviceId: string,
    deviceEntry: DeviceEntry
  ): Promise<ContainerStats[]> {
    const cached = statsCacheMap.get(deviceId);
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const containerListBody = await DockerClient.dockerGet(
        deviceEntry,
        "/containers/json?all=true"
      );
      const containers = JSON.parse(containerListBody) as Record<string, unknown>[];

      const stats = await Promise.all(
        containers.map(async (containerEntry: Record<string, unknown>) => {
          if (containerEntry.State !== "running") {
            return DockerStatsParser.buildStoppedSkeleton(containerEntry, deviceId);
          }

          try {
            const containerId = containerEntry.Id as string;
            const statsBody = await DockerClient.dockerGet(
              deviceEntry,
              `/containers/${containerId}/stats?stream=false&one-shot=true`
            );
            const rawStats = JSON.parse(statsBody) as Record<string, unknown>;

            if (!cpuCounterMap.has(deviceId)) {
              cpuCounterMap.set(deviceId, new Map());
            }
            const deviceCounters = cpuCounterMap.get(deviceId)!;
            const previousCpuState = deviceCounters.get(containerId);

            const parsedStats = DockerStatsParser.parseStats(
              containerEntry,
              rawStats,
              deviceId,
              previousCpuState
            );

            const rawCpuStats = rawStats.cpu_stats as Record<string, unknown> | undefined;
            const rawCpuUsage = rawCpuStats?.cpu_usage as Record<string, unknown> | undefined;
            deviceCounters.set(containerId, {
              cpuTotal: (rawCpuUsage?.total_usage as number) || 0,
              systemTotal: (rawCpuStats?.system_cpu_usage as number) || 0,
            });

            return parsedStats;
          } catch (error: unknown) {
            logger.warn(
              `[DockerStats:${deviceId}] Failed to get stats for ${(containerEntry.Names as string[] | undefined)?.[0]}: ${getErrorMessage(error)}`
            );
            return null;
          }
        })
      );

      const result = (stats.filter(Boolean) as ContainerStats[]).sort((firstContainer, secondContainer) =>
        firstContainer.name.localeCompare(secondContainer.name)
      );

      const counters = cpuCounterMap.get(deviceId);
      if (counters) {
        const activeIds = new Set(containers.map((containerEntry) => containerEntry.Id as string));
        for (const id of counters.keys()) {
          if (!activeIds.has(id)) counters.delete(id);
        }
      }

      statsCacheMap.set(deviceId, { data: result, fetchedAt: Date.now() });
      return result;
    } catch (error: unknown) {
      logger.error(`[DockerStats:${deviceId}] Failed to collect stats: ${getErrorMessage(error)}`);
      const stale = statsCacheMap.get(deviceId);
      if (stale) return stale.data;
      return [];
    }
  }

  public static getHistory(deviceId?: string): Record<string, ContainerSnapshot[]> {
    if (deviceId) {
      return { [deviceId]: historyMap.get(deviceId) || [] };
    }

    const allHistory: Record<string, ContainerSnapshot[]> = {};
    for (const [id, buffer] of historyMap) {
      allHistory[id] = buffer;
    }
    return allHistory;
  }

  public static invalidate(deviceId?: string): void {
    if (deviceId) {
      statsCacheMap.delete(deviceId);
      systemCacheMap.delete(deviceId);
    } else {
      statsCacheMap.clear();
      systemCacheMap.clear();
    }
  }

  public static collectorTimer: ReturnType<typeof setInterval> | null = null;

  public static startCollector(): void {
    if (DockerStatsService.collectorTimer) return;

    DockerStatsService._collectSnapshot();
    DockerStatsService.collectorTimer = setInterval(
      () => DockerStatsService._collectSnapshot(),
      HISTORY_INTERVAL_MS
    );

    const devices = getDockerDevices();
    logger.info(
      `[DockerStats] Ring buffer collector started — ${devices.length} Docker host(s) (every ${HISTORY_INTERVAL_MS / 1000}s, ${HISTORY_MAX_SAMPLES} max samples)`
    );
  }

  public static stopCollector(): void {
    if (DockerStatsService.collectorTimer) {
      clearInterval(DockerStatsService.collectorTimer);
      DockerStatsService.collectorTimer = null;
    }
  }

  public static async _collectSnapshot(): Promise<void> {
    const devices = getDockerDevices();

    await Promise.allSettled(
      devices.map(({ id, device }) => DockerStatsService._collectDeviceSnapshot(id, device))
    );
  }

  public static async _collectDeviceSnapshot(deviceId: string, device: DeviceEntry): Promise<void> {
    try {
      const stats = await DockerStatsService._getAllForDevice(deviceId, device);

      const snapshot = {
        timestamp: new Date().toISOString(),
        containers: {} as ContainerSnapshot["containers"],
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

      if (!historyMap.has(deviceId)) {
        historyMap.set(deviceId, []);
      }

      const history = historyMap.get(deviceId)!;
      history.push(snapshot);
      while (history.length > HISTORY_MAX_SAMPLES) {
        history.shift();
      }

      const now = Date.now();
      const lastPersist = lastPersistMap.get(deviceId) || 0;
      if (now - lastPersist >= ContainerMetricsService.persistIntervalMs) {
        lastPersistMap.set(deviceId, now);
        ContainerMetricsService.persistSnapshot(deviceId, stats).catch((errorObject: unknown) => {
          logger.warn(
            `[DockerStats:${deviceId}] Metrics persist failed: ${getErrorMessage(errorObject)}`
          );
        });
      }
    } catch (error: unknown) {
      logger.warn(`[DockerStats:${deviceId}] Snapshot failed: ${getErrorMessage(error)}`);
    }
  }

  public static async getSystemInfo(deviceId?: string) {
    const devices = getDockerDevices();

    if (deviceId) {
      const target = devices.find((deviceEntry) => deviceEntry.id === deviceId);
      if (!target) throw new Error(`Unknown Docker device: ${deviceId}`);
      return DockerSystemHelper.getSystemInfoForDevice(target.id, target.device);
    }

    const results = await Promise.allSettled(
      devices.map((deviceTarget) =>
        DockerSystemHelper.getSystemInfoForDevice(
          deviceTarget.id,
          deviceTarget.device,
          SYSTEM_REQUEST_TIMEOUT_MS
        ).then((info) => ({
          deviceId: deviceTarget.id,
          deviceName: deviceTarget.device.name,
          ...info,
        }))
      )
    );

    return results
      .filter(
        (promiseResult): promiseResult is PromiseFulfilledResult<{ deviceId: string; deviceName: string }> =>
          promiseResult.status === "fulfilled"
      )
      .map((promiseResult) => promiseResult.value);
  }

  public static dockerRequest(
    device: DeviceEntry,
    method: string,
    path: string,
    options?: { timeout?: number }
  ): Promise<DockerActionResponse> {
    return DockerClient.dockerRequest(device, method, path, options);
  }

  public static dockerGet(
    device: DeviceEntry,
    path: string,
    timeoutMs?: number
  ): Promise<string> {
    return DockerClient.dockerGet(device, path, timeoutMs);
  }
}

DockerStatsService.startCollector();
