import { describe, it, expect } from "vitest";
import { upstreamErrorMessage } from "../SessionAnalyticsRoutes.ts";

describe("upstreamErrorMessage", () => {
  it("reads sessions-service's { error: true, message } envelope", () => {
    expect(
      upstreamErrorMessage(
        { error: true, message: "Missing stats secret" },
        401,
      ),
    ).toBe("Missing stats secret");
  });

  it("reads a string error or a bare message", () => {
    expect(upstreamErrorMessage({ error: "projectId required" }, 400)).toBe(
      "projectId required",
    );
    expect(upstreamErrorMessage({ message: "Service unavailable" }, 503)).toBe(
      "Service unavailable",
    );
  });

  it("falls back to the status when the body says nothing", () => {
    expect(upstreamErrorMessage({ error: true }, 503)).toBe(
      "Sessions service error (503)",
    );
    expect(upstreamErrorMessage(null, 500)).toBe(
      "Sessions service error (500)",
    );
  });
});
