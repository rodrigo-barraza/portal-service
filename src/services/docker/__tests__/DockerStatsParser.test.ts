import { describe, it, expect } from "vitest";
import { DockerStatsParser } from "../DockerStatsParser.ts";

describe("DockerStatsParser", () => {
  const mockContainerDetails = {
    Id: "abcdefabcdef1234567890",
    Names: ["/my-awesome-container"],
    Image: "node:18-alpine",
    State: "running",
    Status: "Up 2 hours",
    Created: 1680000000,
    Command: "node dist/index.js",
    Ports: [
      { IP: "0.0.0.0", PrivatePort: 3000, PublicPort: 3000, Type: "tcp" }
    ],
    Mounts: [
      { Type: "bind", Name: "", Source: "/host/path", Destination: "/container/path", Mode: "rw", RW: true }
    ],
    Labels: { "com.docker.compose.project": "my-project" }
  };

  describe("buildStoppedSkeleton", () => {
    it("should build a valid stopped skeleton from container details", () => {
      const result = DockerStatsParser.buildStoppedSkeleton(mockContainerDetails, "my-device-id");

      expect(result.id).toBe("abcdefabcdef");
      expect(result.name).toBe("my-awesome-container");
      expect(result.image).toBe("node:18-alpine");
      expect(result.state).toBe("running");
      expect(result.status).toBe("Up 2 hours");
      expect(result.created).toBe(1680000000);
      expect(result.command).toBe("node dist/index.js");
      expect(result.device).toBe("my-device-id");
      expect(result.ports).toEqual([
        { ip: "0.0.0.0", privatePort: 3000, publicPort: 3000, type: "tcp" }
      ]);
      expect(result.mounts).toEqual([
        { type: "bind", name: "", source: "/host/path", destination: "/container/path", mode: "rw", rw: true }
      ]);
      expect(result.labels).toEqual({ "com.docker.compose.project": "my-project" });
      
      // Verification of zeroed metrics
      expect(result.cpu.percent).toBe(0);
      expect(result.memory.used).toBe(0);
      expect(result.network.rx).toBe(0);
      expect(result.blockIO.read).toBe(0);
    });
  });

  describe("parseStats", () => {
    it("should correctly calculate CPU, memory, network, and block IO metrics", () => {
      const mockRawStats = {
        cpu_stats: {
          cpu_usage: {
            total_usage: 500000000,
            percpu_usage: [250000000, 250000000]
          },
          system_cpu_usage: 10000000000,
          online_cpus: 2,
          throttling_data: {
            periods: 10,
            throttled_periods: 2,
            throttled_time: 2000
          }
        },
        memory_stats: {
          usage: 150000000,
          limit: 1000000000,
          max_usage: 200000000,
          stats: {
            cache: 50000000,
            rss: 100000000,
            swap: 0
          }
        },
        networks: {
          eth0: {
            rx_bytes: 1000,
            tx_bytes: 2000,
            rx_packets: 10,
            tx_packets: 20,
            rx_dropped: 0,
            tx_dropped: 0,
            rx_errors: 0,
            tx_errors: 0
          },
          eth1: {
            rx_bytes: 500,
            tx_bytes: 500,
            rx_packets: 5,
            tx_packets: 5,
            rx_dropped: 0,
            tx_dropped: 0,
            rx_errors: 0,
            tx_errors: 0
          }
        },
        blkio_stats: {
          io_service_bytes_recursive: [
            { op: "read", value: 10000 },
            { op: "write", value: 20000 }
          ]
        },
        pids_stats: {
          current: 12
        }
      };

      const mockPreviousCpuState = {
        cpuTotal: 400000000,
        systemTotal: 9000000000
      };

      const result = DockerStatsParser.parseStats(
        mockContainerDetails,
        mockRawStats,
        "my-device-id",
        mockPreviousCpuState
      );

      // CPU calculations:
      // cpuDelta = 500000000 - 400000000 = 100000000
      // systemDelta = 10000000000 - 9000000000 = 1000000000
      // online_cpus = 2
      // computedCpuPercent = (100000000 / 1000000000) * 2 * 100 = 20%
      expect(result.cpu.percent).toBe(20);
      expect(result.cpu.cores).toBe(2);

      // Memory calculations:
      // memoryActualUsed = usage (150000000) - cache (50000000) = 100000000
      // memoryLimit = 1000000000
      // memoryPercent = (100000000 / 1000000000) * 100 = 10%
      expect(result.memory.used).toBe(100000000);
      expect(result.memory.limit).toBe(1000000000);
      expect(result.memory.percent).toBe(10);

      // Network aggregation:
      // eth0 (1000 rx, 2000 tx) + eth1 (500 rx, 500 tx) = 1500 rx, 2500 tx
      expect(result.network.rx).toBe(1500);
      expect(result.network.tx).toBe(2500);
      expect(result.network.interfaces.eth0).toEqual({
        rxBytes: 1000,
        txBytes: 2000,
        rxPackets: 10,
        txPackets: 20,
        rxDropped: 0,
        txDropped: 0,
        rxErrors: 0,
        txErrors: 0
      });

      // Block IO parsing:
      expect(result.blockIO.read).toBe(10000);
      expect(result.blockIO.write).toBe(20000);

      // PIDs parsing:
      expect(result.pids).toBe(12);

      // Throttling:
      expect(result.cpuThrottling).toEqual({
        periods: 10,
        throttledPeriods: 2,
        throttledTimeNs: 2000
      });
    });
  });
});
