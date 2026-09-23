import { describe, it, expect } from "vitest";
import {
  GoogleAnalyticsDateHelper,
  isValidAnalyticsPeriod,
} from "../GoogleAnalyticsDateHelper.ts";

describe("isValidAnalyticsPeriod", () => {
  it("accepts the presets and real custom ranges", () => {
    for (const period of [
      "7d",
      "30d",
      "90d",
      "2026-06-01_2026-06-15",
      "2024-02-29_2024-02-29",
    ]) {
      expect(isValidAnalyticsPeriod(period)).toBe(true);
    }
  });

  it("rejects impossible dates, reversed ranges, and other presets", () => {
    for (const period of [
      "14d",
      "2026-02-31_2026-03-05",
      "2026-13-01_2026-13-02",
      "2026-06-15_2026-06-01",
      "2026-06-01",
      "",
    ]) {
      expect(isValidAnalyticsPeriod(period)).toBe(false);
    }
  });
});

describe("GoogleAnalyticsDateHelper", () => {
  describe("periodToDateRange", () => {
    it("should map an N-day preset to N calendar days ending today", () => {
      expect(GoogleAnalyticsDateHelper.periodToDateRange("7d")).toEqual({
        startDate: "6daysAgo",
        endDate: "today",
      });
      expect(GoogleAnalyticsDateHelper.periodToDateRange("30d")).toEqual({
        startDate: "29daysAgo",
        endDate: "today",
      });
      expect(GoogleAnalyticsDateHelper.periodToDateRange("90d")).toEqual({
        startDate: "89daysAgo",
        endDate: "today",
      });
    });

    it("should support custom date range with underscore separator", () => {
      expect(
        GoogleAnalyticsDateHelper.periodToDateRange("2026-06-01_2026-06-15"),
      ).toEqual({
        startDate: "2026-06-01",
        endDate: "2026-06-15",
      });
    });

    it("should default to the 30-day window if preset is unknown", () => {
      expect(GoogleAnalyticsDateHelper.periodToDateRange("unknown")).toEqual({
        startDate: "29daysAgo",
        endDate: "today",
      });
    });
  });

  describe("previousPeriodRange", () => {
    it("should calculate previous period for presets correctly", () => {
      // Current window `29daysAgo → today` is 30 days, so the previous
      // window is the 30 days before it (59daysAgo → 30daysAgo) — equal
      // length, no gap, no overlap.
      expect(GoogleAnalyticsDateHelper.previousPeriodRange("30d")).toEqual({
        startDate: "59daysAgo",
        endDate: "30daysAgo",
      });
      expect(GoogleAnalyticsDateHelper.previousPeriodRange("7d")).toEqual({
        startDate: "13daysAgo",
        endDate: "7daysAgo",
      });
    });

    it("should calculate previous period for custom date ranges correctly", () => {
      expect(
        GoogleAnalyticsDateHelper.previousPeriodRange("2026-06-10_2026-06-15"),
      ).toEqual({
        startDate: "2026-06-04",
        endDate: "2026-06-09",
      });
    });
  });
});
