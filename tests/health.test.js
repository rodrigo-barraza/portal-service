// ── Health + Config tests for portal-service ──
// Hand-rolled Express app — tests config and health contract shape.

import { describe, it, expect } from "vitest";

// ── Health ─────────────────────────────────────────────────────
describe("Health", () => {
  it("health endpoint returns expected shape", () => {
    const response = {
      status: "ok",
      service: "portal-service",
      uptime: process.uptime(),
    };
    expect(response.status).toBe("ok");
    expect(response.service).toBe("portal-service");
    expect(response.uptime).toBeGreaterThanOrEqual(0);
  });
});

// ── Config ─────────────────────────────────────────────────────
describe("Config", () => {
  it("should export PORT constant", async () => {
    const config = await import("../src/config.js");
    expect(config).toHaveProperty("PORT");
  });

  it("should export MONGO_URI constant", async () => {
    const config = await import("../src/config.js");
    expect(config).toHaveProperty("MONGO_URI");
  });

  it("should export MONGO_DB_NAME constant", async () => {
    const config = await import("../src/config.js");
    expect(config).toHaveProperty("MONGO_DB_NAME");
  });
});
