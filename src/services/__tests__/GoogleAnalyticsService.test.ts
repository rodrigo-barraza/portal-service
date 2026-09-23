import { describe, it, expect, vi } from "vitest";

vi.mock("@google-analytics/data", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@google-analytics/data")>();
  return { ...original, BetaAnalyticsDataClient: vi.fn() };
});

import {
  findDateRangeRow,
  parseOverviewRow,
} from "../GoogleAnalyticsService.ts";

const row = (range: string | null, sessions: string) => ({
  dimensionValues: range ? [{ value: range }] : [],
  metricValues: [{ value: sessions }],
});

describe("findDateRangeRow", () => {
  it("matches rows by range name, whatever order GA returns them in", () => {
    const response = {
      dimensionHeaders: [{ name: "dateRange" }],
      rows: [row("previous", "40"), row("current", "50")],
    };
    expect(
      parseOverviewRow(findDateRangeRow(response, "current", 0)).sessions,
    ).toBe(50);
    expect(
      parseOverviewRow(findDateRangeRow(response, "previous", 1)).sessions,
    ).toBe(40);
  });

  it("reads a range with no data as zeros instead of borrowing the other range's row", () => {
    const response = {
      dimensionHeaders: [{ name: "dateRange" }],
      rows: [row("previous", "40")],
    };
    expect(
      parseOverviewRow(findDateRangeRow(response, "current", 0)).sessions,
    ).toBe(0);
  });

  it("falls back to request order without a dateRange header", () => {
    const response = { rows: [row(null, "7"), row(null, "3")] };
    expect(
      parseOverviewRow(findDateRangeRow(response, "current", 0)).sessions,
    ).toBe(7);
    expect(
      parseOverviewRow(findDateRangeRow(response, "previous", 1)).sessions,
    ).toBe(3);
  });
});
