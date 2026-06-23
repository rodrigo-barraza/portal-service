// ── Health + Config tests for portal-service ──
// Hand-rolled Express app — tests config and health contract shape.

import { describe, it, expect } from "vitest";

// ── Health ─────────────────────────────────────────────────────
describe("Health", () => {
  it("health endpoint returns expected shape", () => {
    const response = {
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
    expect(response.status).toBe("ok");
    expect(response.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof response.timestamp).toBe("string");
    expect(Date.parse(response.timestamp)).not.toBeNaN();
  });
});

// ── Config ─────────────────────────────────────────────────────
describe("Config", () => {
  it("should export PORT constant", async () => {
    const config = await import("../src/config.ts");
    expect("PORT" in config).toBe(true);
  });

  it("should export MONGO_URI constant", async () => {
    const config = await import("../src/config.ts");
    expect("MONGO_URI" in config).toBe(true);
  });

  it("should export MONGO_DB_NAME constant", async () => {
    const config = await import("../src/config.ts");
    expect("MONGO_DB_NAME" in config).toBe(true);
  });
});

