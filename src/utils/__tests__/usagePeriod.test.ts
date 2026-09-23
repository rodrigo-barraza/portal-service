import { describe, it, expect } from "vitest";
import {
  sanitizeUsagePeriod,
  usagePeriodDays,
  usagePeriodStart,
} from "../usagePeriod.ts";

describe("usage periods", () => {
  it("accepts the dashboard's periods and folds everything else to 30d", () => {
    expect(sanitizeUsagePeriod("14d")).toBe("14d");
    expect(sanitizeUsagePeriod("365d")).toBe("30d");
    expect(sanitizeUsagePeriod(["7d"])).toBe("30d");
    expect(sanitizeUsagePeriod(undefined)).toBe("30d");
  });

  it("converts to days and a window start", () => {
    expect(usagePeriodDays("90d")).toBe(90);
    expect(usagePeriodDays("junk")).toBe(30);
    expect(usagePeriodStart("7d", Date.UTC(2026, 8, 22)).toISOString()).toBe(
      "2026-09-15T00:00:00.000Z",
    );
  });
});
