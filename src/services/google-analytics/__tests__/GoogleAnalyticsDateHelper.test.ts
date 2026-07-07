import { describe, it, expect } from "vitest";
import { GoogleAnalyticsDateHelper } from "../GoogleAnalyticsDateHelper.ts";

describe("GoogleAnalyticsDateHelper", () => {
  describe("periodToDateRange", () => {
    it("should map presets correctly", () => {
      expect(GoogleAnalyticsDateHelper.periodToDateRange("7d")).toEqual({
        startDate: "7daysAgo",
        endDate: "today",
      });
      expect(GoogleAnalyticsDateHelper.periodToDateRange("30d")).toEqual({
        startDate: "30daysAgo",
        endDate: "today",
      });
      expect(GoogleAnalyticsDateHelper.periodToDateRange("90d")).toEqual({
        startDate: "90daysAgo",
        endDate: "today",
      });
    });

    it("should support custom date range with underscore separator", () => {
      expect(GoogleAnalyticsDateHelper.periodToDateRange("2026-06-01_2026-06-15")).toEqual({
        startDate: "2026-06-01",
        endDate: "2026-06-15",
      });
    });

    it("should default to 30daysAgo if preset is unknown", () => {
      expect(GoogleAnalyticsDateHelper.periodToDateRange("unknown")).toEqual({
        startDate: "30daysAgo",
        endDate: "today",
      });
    });
  });

  describe("previousPeriodRange", () => {
    it("should calculate previous period for presets correctly", () => {
      expect(GoogleAnalyticsDateHelper.previousPeriodRange("30d")).toEqual({
        startDate: "60daysAgo",
        endDate: "31daysAgo",
      });
      expect(GoogleAnalyticsDateHelper.previousPeriodRange("7d")).toEqual({
        startDate: "14daysAgo",
        endDate: "8daysAgo",
      });
    });

    it("should calculate previous period for custom date ranges correctly", () => {
      expect(GoogleAnalyticsDateHelper.previousPeriodRange("2026-06-10_2026-06-15")).toEqual({
        startDate: "2026-06-04",
        endDate: "2026-06-09",
      });
    });
  });
});
