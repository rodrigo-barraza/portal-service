import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

vi.mock("../../config.ts", () => ({
  PROJECTS: {
    "api-service": { name: "API", dockerProject: "api-service", device: "nas" },
    "web-client": { name: "Web", dockerProject: "web-client", device: "nas" },
    "remote-bot": {
      name: "Bot",
      dockerProject: "remote-bot",
      device: "laptop",
    },
    "docs-library": { name: "Docs", dockerProject: null, device: "nas" },
  },
}));

vi.mock("../../services/docker/ContainerActions.ts", () => ({
  CONTAINER_ACTIONS: [],
  runContainerAction: vi.fn(),
  resolveDockerDevice: (deviceId: string) =>
    deviceId === "nas"
      ? { id: "nas", device: { dockerApi: "http://nas" } }
      : null,
}));

vi.mock("../../services/docker/ContainerRollback.ts", () => ({
  rollbackToPreviousImage: vi.fn(),
  getPreviousImage: vi.fn(async (_device: unknown, image: string) => {
    if (image === "web-client") throw new Error("inspect timed out");
    return {
      tag: `${image}:previous`,
      created: null,
      size: 1,
      gitSha: "abc",
      gitBranch: null,
      buildTime: null,
    };
  }),
}));

const { default: serviceControlRouter } =
  await import("../ServiceControlRoutes.ts");
const { errorHandler } = await import("../../utils/errors.ts");

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/services", serviceControlRouter);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("GET /services/rollback-status", () => {
  it("answers every containerized project in one response, keyed by id", async () => {
    const response = await fetch(`${base}/services/rollback-status`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      "api-service",
      "remote-bot",
      "web-client",
    ]);
    expect(body["api-service"]).toMatchObject({
      available: true,
      device: "nas",
      previousImage: { tag: "api-service:previous" },
    });
    // One failing inspect degrades that project only, never the whole batch.
    expect(body["web-client"]).toEqual({
      available: false,
      reason: "No previous image found",
    });
    expect(body["remote-bot"]).toEqual({
      available: false,
      reason: "No Docker API configured",
    });
  });
});

describe("GET /services/:id/rollback-status", () => {
  it("answers one project with the same shape", async () => {
    const response = await fetch(
      `${base}/services/api-service/rollback-status`,
    );
    expect(await response.json()).toMatchObject({
      available: true,
      service: "API",
    });
  });

  it("404s an unknown project", async () => {
    const response = await fetch(`${base}/services/nope/rollback-status`);
    expect(response.status).toBe(404);
  });
});
