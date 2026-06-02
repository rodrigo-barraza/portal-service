import type { ContainerStats, NetworkInterfaceStats } from "../../types.ts";

export class DockerStatsParser {
  public static buildStoppedSkeleton(
    containerDetails: Record<string, unknown>,
    deviceId: string
  ): ContainerStats {
    const containerName = (
      (containerDetails.Names as string[] | undefined)?.[0] || "unknown"
    ).replace(/^\//, "");
    const executionCommand = (containerDetails.Command as string) || "";

    const portsMapped = (
      (containerDetails.Ports as Record<string, unknown>[]) || []
    ).map((portEntry: Record<string, unknown>) => ({
      ip: (portEntry.IP as string) || "",
      privatePort: (portEntry.PrivatePort as number) || 0,
      publicPort: (portEntry.PublicPort as number) || 0,
      type: (portEntry.Type as string) || "",
    }));

    const mountsMapped = (
      (containerDetails.Mounts as Record<string, unknown>[]) || []
    ).map((mountEntry: Record<string, unknown>) => ({
      type: (mountEntry.Type as string) || "",
      name: (mountEntry.Name as string) || "",
      source: (mountEntry.Source as string) || "",
      destination: (mountEntry.Destination as string) || "",
      mode: (mountEntry.Mode as string) || "rw",
      rw: (mountEntry.RW as boolean) ?? true,
    }));

    const labelsMapped = (containerDetails.Labels as Record<string, string>) || {};

    return {
      id: (containerDetails.Id as string).substring(0, 12),
      name: containerName,
      image: (containerDetails.Image as string) || "",
      state: (containerDetails.State as string) || "",
      status: (containerDetails.Status as string) || "",
      created: (containerDetails.Created as number) || 0,
      command: executionCommand,
      ports: portsMapped,
      mounts: mountsMapped,
      labels: labelsMapped,
      device: deviceId,
      cpu: { percent: 0, cores: 0 },
      cpuThrottling: { periods: 0, throttledPeriods: 0, throttledTimeNs: 0 },
      memory: { used: 0, limit: 0, percent: 0 },
      memoryDetail: {
        rss: 0,
        cache: 0,
        swap: 0,
        maxUsage: 0,
        activeAnon: 0,
        inactiveAnon: 0,
        pgfault: 0,
        pgmajfault: 0,
      },
      network: {
        rx: 0,
        tx: 0,
        rxPackets: 0,
        txPackets: 0,
        rxDropped: 0,
        txDropped: 0,
        rxErrors: 0,
        txErrors: 0,
        interfaces: {},
      },
      blockIO: { read: 0, write: 0 },
      pids: 0,
    };
  }

  public static parseStats(
    containerDetails: Record<string, unknown>,
    rawStats: Record<string, unknown>,
    deviceId: string,
    previousCpuState: { cpuTotal: number; systemTotal: number } | undefined
  ): ContainerStats {
    const rawCpuStats = rawStats.cpu_stats as Record<string, unknown> | undefined;
    const rawCpuUsage = rawCpuStats?.cpu_usage as Record<string, unknown> | undefined;

    const currentCpuTotal = (rawCpuUsage?.total_usage as number) || 0;
    const currentSystemTotal = (rawCpuStats?.system_cpu_usage as number) || 0;
    const onlineCpusCount =
      (rawCpuStats?.online_cpus as number) ||
      (rawCpuUsage?.percpu_usage as number[])?.length ||
      1;

    let computedCpuPercent = 0;
    if (previousCpuState) {
      const cpuDelta = currentCpuTotal - previousCpuState.cpuTotal;
      const systemDelta = currentSystemTotal - previousCpuState.systemTotal;
      if (systemDelta > 0 && cpuDelta > 0) {
        computedCpuPercent = (cpuDelta / systemDelta) * onlineCpusCount * 100;
      }
    }

    const rawMemoryStats = rawStats.memory_stats as Record<string, unknown> | undefined;
    const rawMemoryStatsDetails = rawMemoryStats?.stats as Record<string, unknown> | undefined;

    const memoryUsageRaw = (rawMemoryStats?.usage as number) || 0;
    const memoryCacheRaw =
      (rawMemoryStatsDetails?.cache as number) ||
      (rawMemoryStatsDetails?.inactive_file as number) ||
      0;
    const memoryActualUsed = memoryUsageRaw - memoryCacheRaw;
    const memoryLimitRaw = (rawMemoryStats?.limit as number) || 0;
    const memoryPercentUsed = memoryLimitRaw > 0 ? (memoryActualUsed / memoryLimitRaw) * 100 : 0;

    let netRx = 0;
    let netTx = 0;
    let netRxPackets = 0;
    let netTxPackets = 0;
    let netRxDropped = 0;
    let netTxDropped = 0;
    let netRxErrors = 0;
    let netTxErrors = 0;
    const networkInterfacesMapped: Record<string, NetworkInterfaceStats> = {};

    const networksData = rawStats.networks as Record<string, Record<string, number>> | undefined;
    if (networksData) {
      for (const [interfaceName, networkMetrics] of Object.entries(networksData)) {
        const rxBytes = networkMetrics.rx_bytes || 0;
        const txBytes = networkMetrics.tx_bytes || 0;
        const rxPackets = networkMetrics.rx_packets || 0;
        const txPackets = networkMetrics.tx_packets || 0;
        const rxDropped = networkMetrics.rx_dropped || 0;
        const txDropped = networkMetrics.tx_dropped || 0;
        const rxErrors = networkMetrics.rx_errors || 0;
        const txErrors = networkMetrics.tx_errors || 0;

        netRx += rxBytes;
        netTx += txBytes;
        netRxPackets += rxPackets;
        netTxPackets += txPackets;
        netRxDropped += rxDropped;
        netTxDropped += txDropped;
        netRxErrors += rxErrors;
        netTxErrors += txErrors;

        networkInterfacesMapped[interfaceName] = {
          rxBytes,
          txBytes,
          rxPackets,
          txPackets,
          rxDropped,
          txDropped,
          rxErrors,
          txErrors,
        };
      }
    }

    let blockReadBytes = 0;
    let blockWriteBytes = 0;
    const rawBlockIoStats = rawStats.blkio_stats as Record<string, unknown> | undefined;
    const rawBlockIoEntries = rawBlockIoStats?.io_service_bytes_recursive as
      | Array<{ op: string; value: number }>
      | undefined;

    if (rawBlockIoEntries) {
      for (const blockEntry of rawBlockIoEntries) {
        if (blockEntry.op === "read" || blockEntry.op === "Read") {
          blockReadBytes += blockEntry.value || 0;
        }
        if (blockEntry.op === "write" || blockEntry.op === "Write") {
          blockWriteBytes += blockEntry.value || 0;
        }
      }
    }

    const rawPidsStats = rawStats.pids_stats as Record<string, unknown> | undefined;
    const pidsCount = (rawPidsStats?.current as number) || 0;

    const memoryDetailsMapped = {
      rss: (rawMemoryStatsDetails?.rss as number) || 0,
      cache: memoryCacheRaw,
      swap: (rawMemoryStatsDetails?.swap as number) || 0,
      maxUsage: (rawMemoryStats?.max_usage as number) || 0,
      activeAnon: (rawMemoryStatsDetails?.active_anon as number) || 0,
      inactiveAnon: (rawMemoryStatsDetails?.inactive_anon as number) || 0,
      pgfault: (rawMemoryStatsDetails?.pgfault as number) || 0,
      pgmajfault: (rawMemoryStatsDetails?.pgmajfault as number) || 0,
    };

    const rawThrottlingData = rawCpuStats?.throttling_data as Record<string, number> | undefined;
    const cpuThrottlingMapped = {
      periods: rawThrottlingData?.periods || 0,
      throttledPeriods: rawThrottlingData?.throttled_periods || 0,
      throttledTimeNs: rawThrottlingData?.throttled_time || 0,
    };

    const executionCommand = (containerDetails.Command as string) || "";
    const portsMapped = (
      (containerDetails.Ports as Record<string, unknown>[]) || []
    ).map((portEntry: Record<string, unknown>) => ({
      ip: (portEntry.IP as string) || "",
      privatePort: (portEntry.PrivatePort as number) || 0,
      publicPort: (portEntry.PublicPort as number) || 0,
      type: (portEntry.Type as string) || "",
    }));

    const mountsMapped = (
      (containerDetails.Mounts as Record<string, unknown>[]) || []
    ).map((mountEntry: Record<string, unknown>) => ({
      type: (mountEntry.Type as string) || "",
      name: (mountEntry.Name as string) || "",
      source: (mountEntry.Source as string) || "",
      destination: (mountEntry.Destination as string) || "",
      mode: (mountEntry.Mode as string) || "rw",
      rw: (mountEntry.RW as boolean) ?? true,
    }));

    const labelsMapped = (containerDetails.Labels as Record<string, string>) || {};
    const containerName = (
      (containerDetails.Names as string[] | undefined)?.[0] || "unknown"
    ).replace(/^\//, "");

    return {
      id: (containerDetails.Id as string).substring(0, 12),
      name: containerName,
      image: (containerDetails.Image as string) || "",
      state: (containerDetails.State as string) || "",
      status: (containerDetails.Status as string) || "",
      created: (containerDetails.Created as number) || 0,
      command: executionCommand,
      ports: portsMapped,
      mounts: mountsMapped,
      labels: labelsMapped,
      device: deviceId,
      cpu: {
        percent: Math.round(computedCpuPercent * 100) / 100,
        cores: onlineCpusCount,
      },
      cpuThrottling: cpuThrottlingMapped,
      memory: {
        used: memoryActualUsed,
        limit: memoryLimitRaw,
        percent: Math.round(memoryPercentUsed * 100) / 100,
      },
      memoryDetail: memoryDetailsMapped,
      network: {
        rx: netRx,
        tx: netTx,
        rxPackets: netRxPackets,
        txPackets: netTxPackets,
        rxDropped: netRxDropped,
        txDropped: netTxDropped,
        rxErrors: netRxErrors,
        txErrors: netTxErrors,
        interfaces: networkInterfacesMapped,
      },
      blockIO: { read: blockReadBytes, write: blockWriteBytes },
      pids: pidsCount,
    };
  }
}
