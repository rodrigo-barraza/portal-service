import { describe, it, expect } from "vitest";
import { isValidPushToken } from "../WatchdogRoutes.ts";

describe("isValidPushToken", () => {
  it("accepts only the exact token", () => {
    expect(isValidPushToken("s3cret-token", "s3cret-token")).toBe(true);
    expect(isValidPushToken("s3cret-toke", "s3cret-token")).toBe(false);
    expect(isValidPushToken("s3cret-token-", "s3cret-token")).toBe(false);
    expect(isValidPushToken("", "s3cret-token")).toBe(false);
  });

  it("rejects everything when no token is configured", () => {
    expect(isValidPushToken("", "")).toBe(false);
    expect(isValidPushToken("anything", "")).toBe(false);
  });
});
