import { describe, it, expect } from "vitest";
import { DateHelpers } from "../DateHelpers.ts";

describe("DateHelpers", () => {
  it("should parse range string '5m' to correct milliseconds", () => {
    const millisecondsResult = DateHelpers.parseRangeToMilliseconds("5m");
    expect(millisecondsResult).toBe(5 * 60 * 1000);
  });

  it("should parse range string '2h' to correct milliseconds", () => {
    const millisecondsResult = DateHelpers.parseRangeToMilliseconds("2h");
    expect(millisecondsResult).toBe(2 * 60 * 60 * 1000);
  });

  it("should parse range string '3d' to correct milliseconds", () => {
    const millisecondsResult = DateHelpers.parseRangeToMilliseconds("3d");
    expect(millisecondsResult).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("should default to 1 hour (3600000ms) on invalid format", () => {
    const millisecondsResult = DateHelpers.parseRangeToMilliseconds("invalid");
    expect(millisecondsResult).toBe(60 * 60 * 1000);
  });

  it("should default to 1 hour on unknown unit", () => {
    const millisecondsResult = DateHelpers.parseRangeToMilliseconds("10x");
    expect(millisecondsResult).toBe(60 * 60 * 1000);
  });
});
