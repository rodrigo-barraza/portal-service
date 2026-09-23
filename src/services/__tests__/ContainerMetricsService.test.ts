import { describe, it, expect, vi, beforeEach } from "vitest";

const aggregate = vi.hoisted(() => vi.fn());
vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getDb: () => ({ collection: () => ({ aggregate }) }) },
}));

import ContainerMetricsService, {
  metricsSeriesKey,
} from "../ContainerMetricsService.ts";

const point = (cpu: number, t: string) => ({
  t: new Date(t),
  cpu,
  mem: 1,
  memLimit: 2,
  netRx: 0,
  netTx: 0,
  pids: 1,
});

beforeEach(() => {
  aggregate.mockReset();
});

describe("ContainerMetricsService.getHistory", () => {
  it("keeps same-named containers on different devices apart", async () => {
    aggregate.mockReturnValue({
      toArray: async () => [
        {
          _id: { container: "watchtower", device: "synology" },
          points: [
            point(2, "2026-09-22T10:01:00Z"),
            point(1, "2026-09-22T10:00:00Z"),
          ],
        },
        {
          _id: { container: "watchtower", device: "workstation2" },
          points: [point(9, "2026-09-22T10:00:00Z")],
        },
      ],
    });

    const history = await ContainerMetricsService.getHistory({ range: "1h" });

    expect(Object.keys(history.containers).sort()).toEqual([
      "synology/watchtower",
      "workstation2/watchtower",
    ]);
    expect(
      history.containers[metricsSeriesKey("workstation2", "watchtower")],
    ).toMatchObject({
      container: "watchtower",
      device: "workstation2",
    });
    // $topN hands back newest-first; the series is chronological
    expect(
      history.containers["synology/watchtower"].points.map(
        (entry) => entry.cpu,
      ),
    ).toEqual([1, 2]);
    expect(history.samples).toBe(3);
  });

  it("caps the lookback at the collection's 7-day TTL", async () => {
    aggregate.mockReturnValue({ toArray: async () => [] });
    const before = Date.now();

    const history = await ContainerMetricsService.getHistory({
      range: "99999999d",
    });

    const since = Date.parse(history.since ?? "");
    expect(Number.isFinite(since)).toBe(true);
    expect(before - since).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1_000);
  });

  it("filters by container and device when asked", async () => {
    aggregate.mockReturnValue({ toArray: async () => [] });
    await ContainerMetricsService.getHistory({
      container: "prism-service",
      device: "synology",
    });
    const match = aggregate.mock.calls[0][0][0].$match;
    expect(match["metadata.container"]).toBe("prism-service");
    expect(match["metadata.device"]).toBe("synology");
  });
});
