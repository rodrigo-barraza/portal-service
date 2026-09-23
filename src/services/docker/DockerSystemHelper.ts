import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { DeviceEntry, DeviceSpecs } from "../../types.ts";
import { DockerClient } from "../../wrappers/DockerClient.ts";

const execFileAsync = promisify(execFile);

/** `df -B1 /` data line → byte totals (the last line; the first is the header). */
export function parseDfOutput(dfOutput: string): { total: number; used: number; available: number; percent: number } | null {
  const lastLine = dfOutput.trim().split("\n").pop() ?? "";
  const parts = lastLine.trim().split(/\s+/);
  if (parts.length < 5 || !parts.slice(1, 4).every((part) => /^\d+$/.test(part))) return null;

  const total = Number.parseInt(parts[1], 10);
  const used = Number.parseInt(parts[2], 10);
  const available = Number.parseInt(parts[3], 10);
  return {
    total,
    used,
    available,
    percent: total > 0 ? Math.round((used / total) * 10000) / 100 : 0,
  };
}

export class DockerSystemHelper {
  /**
   * Lightweight hardware specs from Docker's /info only — skips the
   * /system/df disk walk, so it's safe to call from list endpoints.
   */
  public static async getSpecsForDevice(
    deviceEntry: DeviceEntry,
    timeoutMs: number = 10000
  ): Promise<DeviceSpecs> {
    const infoResponseBody = await DockerClient.dockerGet(deviceEntry, "/info", timeoutMs);
    const infoParsed = JSON.parse(infoResponseBody);
    return {
      cpus: (infoParsed.NCPU as number) || 0,
      memoryBytes: (infoParsed.MemTotal as number) || 0,
      os: (infoParsed.OperatingSystem as string) || "",
      architecture: (infoParsed.Architecture as string) || "",
      dockerVersion: (infoParsed.ServerVersion as string) || "",
      collectedAt: new Date().toISOString(),
    };
  }

  public static async getSystemInfoForDevice(
    deviceId: string,
    deviceEntry: DeviceEntry,
    systemRequestTimeout: number = 30000
  ): Promise<Record<string, unknown>> {
    const [infoResponseBody, diskFreeResponseBody] = await Promise.all([
      DockerClient.dockerGet(deviceEntry, "/info", systemRequestTimeout),
      DockerClient.dockerGet(deviceEntry, "/system/df", systemRequestTimeout),
    ]);

    const infoParsed = JSON.parse(infoResponseBody);
    const diskFreeStats = JSON.parse(diskFreeResponseBody);

    const imagesMapped = ((diskFreeStats.Images as Record<string, unknown>[]) || []).map(
      (imageEntry: Record<string, unknown>) => ({
        id: (imageEntry.Id as string)?.substring(0, 12) || "unknown",
        tags: (imageEntry.RepoTags as string[]) || [],
        size: (imageEntry.Size as number) || 0,
        sharedSize: (imageEntry.SharedSize as number) || 0,
        created: (imageEntry.Created as number) || 0,
        containers: (imageEntry.Containers as number) || 0,
      })
    );

    const totalImageSize = imagesMapped.reduce((sum, image) => sum + image.size, 0);
    const totalImageShared = imagesMapped.reduce((sum, image) => sum + image.sharedSize, 0);

    const volumesMapped = ((diskFreeStats.Volumes as Record<string, unknown>[]) || []).map(
      (volumeEntry: Record<string, unknown>) => ({
        name: volumeEntry.Name as string,
        driver: volumeEntry.Driver as string,
        size: (volumeEntry.UsageData as Record<string, number>)?.Size || 0,
        refCount: (volumeEntry.UsageData as Record<string, number>)?.RefCount || 0,
      })
    );

    const totalVolumeSize = volumesMapped.reduce((sum, volume) => sum + volume.size, 0);

    const buildCacheEntries = (diskFreeStats.BuildCache as Record<string, unknown>[]) || [];
    const totalBuildCacheSize = buildCacheEntries.reduce(
      (sum, entry) => sum + ((entry.Size as number) || 0),
      0
    );

    const containersDiskFree = ((diskFreeStats.Containers as Record<string, unknown>[]) || []).map(
      (containerEntry: Record<string, unknown>) => ({
        id: (containerEntry.Id as string)?.substring(0, 12) || "unknown",
        names: (containerEntry.Names as string[]) || [],
        sizeRw: (containerEntry.SizeRw as number) || 0,
        sizeRootFs: (containerEntry.SizeRootFs as number) || 0,
        state: containerEntry.State as string,
      })
    );

    const totalContainerWritableSize = containersDiskFree.reduce(
      (sum, container) => sum + container.sizeRw,
      0
    );

    let hostDiskStats = null;
    if (deviceEntry.dockerApi?.startsWith("unix://")) {
      try {
        // execFile, no shell; async so a slow disk can't block the event loop
        const { stdout } = await execFileAsync("df", ["-B1", "/"], { encoding: "utf8", timeout: 3000 });
        hostDiskStats = parseDfOutput(stdout);
      } catch (error: unknown) {
        logger.warn(
          `[DockerSystemHelper:${deviceId}] Host disk stats failed: ${getErrorMessage(error)}`
        );
      }
    }

    return {
      deviceId,
      serverVersion: infoParsed.ServerVersion,
      os: infoParsed.OperatingSystem,
      architecture: infoParsed.Architecture,
      totalMemory:
        infoParsed.MemTotal || (deviceEntry.dockerApi?.startsWith("unix://") ? os.totalmem() : 0),
      cpus: infoParsed.NCPU || (deviceEntry.dockerApi?.startsWith("unix://") ? os.cpus().length : 0),
      containersRunning: infoParsed.ContainersRunning,
      containersStopped: infoParsed.ContainersStopped,
      containersPaused: infoParsed.ContainersPaused,
      containersTotal: infoParsed.Containers,
      hostDisk: hostDiskStats,
      disk: {
        images: {
          count: imagesMapped.length,
          totalSize: totalImageSize,
          sharedSize: totalImageShared,
          items: imagesMapped.sort((firstImage, secondImage) => secondImage.size - firstImage.size).slice(0, 20),
        },
        volumes: {
          count: volumesMapped.length,
          totalSize: totalVolumeSize,
          items: volumesMapped.sort((firstVolume, secondVolume) => secondVolume.size - firstVolume.size),
        },
        buildCache: {
          count: buildCacheEntries.length,
          totalSize: totalBuildCacheSize,
        },
        containers: {
          count: containersDiskFree.length,
          totalWritableSize: totalContainerWritableSize,
        },
        totalReclaimable:
          totalImageSize + totalVolumeSize + totalBuildCacheSize + totalContainerWritableSize,
      },
      fetchedAt: new Date().toISOString(),
    };
  }
}
