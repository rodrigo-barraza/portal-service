// ── Health + Config tests for portal-service ──
// Hand-rolled Express app — tests config and health contract shape.

import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("express", async (importOriginal) => {
  const original = await importOriginal<typeof import("express")>();
  return {
    ...original,
    Router: () => ({
      get: (path: string, handler: any) => {
        if (path === "/") {
          (globalThis as any).healthHandler = handler;
        }
      },
    }),
  };
});

import "../src/routes/HealthRoutes.ts";

// ── Health ─────────────────────────────────────────────────────
describe("Health", () => {
  it("health endpoint returns expected shape", () => {
    const healthHandler = (globalThis as any).healthHandler;
    expect(healthHandler).toBeDefined();

    const requestMock = {} as Request;
    const jsonSpy = vi.fn();
    const responseMock = {
      json: jsonSpy,
    } as unknown as Response;

    healthHandler(requestMock, responseMock);

    expect(jsonSpy).toHaveBeenCalled();
    const response = jsonSpy.mock.calls[0][0];
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

