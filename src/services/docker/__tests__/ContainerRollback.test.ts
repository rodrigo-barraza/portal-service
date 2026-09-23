// ── ContainerRollback against a fake Docker Engine ──
// A small in-memory engine (containers by name/id, tags → image ids)
// answers DockerClient calls, so the whole swap-and-recreate sequence and
// every failure path can be exercised without Docker.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DockerResponse } from "../../../wrappers/DockerClient.ts";

interface FakeContainer {
  id: string;
  name: string;
  image: string;
  running: boolean;
}

const engine = vi.hoisted(() => ({
  // Images exist independently of their tags (moving :latest off an
  // image leaves it taggable by ID).
  images: new Set<string>(),
  tags: new Map<string, string>(),
  containers: [] as FakeContainer[],
  failures: {} as Record<string, "status" | "throw">,
  calls: [] as string[],
  nextId: 1,
}));

function reply(statusCode: number, body: unknown = ""): DockerResponse {
  return { statusCode, body: typeof body === "string" ? body : JSON.stringify(body) };
}

function findContainer(reference: string) {
  return engine.containers.find((container) => container.id === reference || container.name === reference);
}

async function fakeRequest(_device: unknown, method: string, path: string, _options?: unknown): Promise<DockerResponse> {
  const url = new URL(path, "http://docker");
  const route = `${method} ${url.pathname.replace(/\/[^/]+(?=\/(stop|start|rename|tag|json)$)/, "/:ref")}`;
  engine.calls.push(`${method} ${path}`);

  const failure = engine.failures[route] ?? engine.failures[`${method} ${url.pathname}`];
  if (failure === "throw") throw new Error(`Docker API timeout (${route})`);
  if (failure === "status") return reply(500, { message: `injected failure: ${route}` });

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] === "images" && segments[2] === "json") {
    const imageId = engine.tags.get(segments[1]);
    return imageId ? reply(200, { Id: imageId, Created: "2026-09-01T00:00:00Z", Size: 10, Config: { Labels: { "git.sha": "abc" } } }) : reply(404);
  }
  if (segments[0] === "images" && segments[2] === "tag") {
    const imageId = engine.images.has(segments[1]) ? segments[1] : engine.tags.get(segments[1]);
    if (!imageId) return reply(404);
    engine.tags.set(`${url.searchParams.get("repo")}:${url.searchParams.get("tag")}`, imageId);
    return reply(201);
  }
  if (segments[0] === "containers" && segments[1] === "create") {
    const name = url.searchParams.get("name")!;
    if (findContainer(name)) return reply(409, { message: "name in use" });
    const container = { id: `new-${engine.nextId++}`, name, image: "", running: false };
    engine.containers.push(container);
    return reply(201, { Id: container.id });
  }
  const container = findContainer(segments[1]);
  if (!container) return reply(404, { message: "No such container" });
  switch (`${method} ${segments[2] ?? ""}`) {
    case "POST stop":
      if (!container.running) return reply(304);
      container.running = false;
      return reply(204);
    case "POST start":
      if (container.running) return reply(304);
      container.running = true;
      return reply(204);
    case "POST rename":
      container.name = url.searchParams.get("name")!;
      return reply(204);
    case "DELETE ":
      engine.containers.splice(engine.containers.indexOf(container), 1);
      return reply(204);
    case "GET json":
      return reply(200, { Id: container.id, Config: { Image: container.image }, HostConfig: {}, NetworkSettings: { Networks: {} } });
  }
  return reply(400);
}

vi.mock("../../../wrappers/DockerClient.ts", () => ({
  DockerClient: {
    dockerRequest: vi.fn(fakeRequest),
    dockerGetJson: vi.fn(async (device: unknown, path: string) => {
      const response = await fakeRequest(device, "GET", path);
      if (response.statusCode !== 200) throw new Error(`status ${response.statusCode}`);
      return JSON.parse(response.body);
    }),
  },
}));

import { getPreviousImage, rollbackToPreviousImage } from "../ContainerRollback.ts";

const device = { name: "NAS", type: "NAS", hostname: "", os: "", sshAlias: null, dockerBin: null, dockerApi: "unix:///var/run/docker.sock", notes: "" };

beforeEach(() => {
  engine.images = new Set(["sha-new", "sha-old"]);
  engine.tags = new Map([
    ["notes-service:latest", "sha-new"],
    ["notes-service:previous", "sha-old"],
  ]);
  engine.containers = [{ id: "c-original", name: "notes-service", image: "sha-new", running: true }];
  engine.failures = {};
  engine.calls = [];
  engine.nextId = 1;
});

describe("rollbackToPreviousImage", () => {
  it("swaps the tags and replaces the container", async () => {
    await rollbackToPreviousImage(device, "notes-service", "notes-service");

    expect(engine.tags.get("notes-service:latest")).toBe("sha-old");
    expect(engine.tags.get("notes-service:previous")).toBe("sha-new"); // roll-forward target
    expect(engine.containers).toHaveLength(1);
    expect(engine.containers[0]).toMatchObject({ name: "notes-service", running: true });
    expect(engine.containers[0].id).not.toBe("c-original");
  });

  it("refuses with a 400 when there is no :previous image", async () => {
    engine.tags.delete("notes-service:previous");
    await expect(rollbackToPreviousImage(device, "notes-service", "notes-service")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(engine.containers[0]).toMatchObject({ id: "c-original", running: true });
  });

  it("restores the original container and the tags when the create call times out", async () => {
    engine.failures["POST /containers/create"] = "throw";

    await expect(rollbackToPreviousImage(device, "notes-service", "notes-service")).rejects.toMatchObject({
      statusCode: 502,
    });

    expect(engine.containers).toEqual([{ id: "c-original", name: "notes-service", image: "sha-new", running: true }]);
    expect(engine.tags.get("notes-service:latest")).toBe("sha-new");
    expect(engine.tags.get("notes-service:previous")).toBe("sha-old");
  });

  it("removes a replacement that fails to start and brings the original back", async () => {
    engine.failures["POST /containers/:ref/start"] = "status";
    // The original's own restart must still work: fail only the new container's start
    const originalRequest = fakeRequest;
    const { DockerClient } = await import("../../../wrappers/DockerClient.ts");
    vi.mocked(DockerClient.dockerRequest).mockImplementation(async (deviceEntry, method, path, options) => {
      if (method === "POST" && path.startsWith("/containers/c-original/start")) {
        delete engine.failures["POST /containers/:ref/start"];
      }
      return originalRequest(deviceEntry, method, path, options);
    });

    await expect(rollbackToPreviousImage(device, "notes-service", "notes-service")).rejects.toMatchObject({
      statusCode: 502,
    });

    expect(engine.containers).toEqual([{ id: "c-original", name: "notes-service", image: "sha-new", running: true }]);
    expect(engine.tags.get("notes-service:latest")).toBe("sha-new");
    vi.mocked(DockerClient.dockerRequest).mockImplementation(fakeRequest);
  });

  it("restarts the original when the stop call errors", async () => {
    engine.failures["POST /containers/:ref/stop"] = "throw";
    await expect(rollbackToPreviousImage(device, "notes-service", "notes-service")).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(engine.containers[0]).toMatchObject({ id: "c-original", name: "notes-service", running: true });
    expect(engine.calls).toContain("POST /containers/c-original/start");
  });
});

describe("getPreviousImage", () => {
  it("describes the :previous image, or null without one", async () => {
    expect(await getPreviousImage(device, "notes-service")).toMatchObject({
      tag: "notes-service:previous",
      gitSha: "abc",
      size: 10,
    });
    engine.tags.delete("notes-service:previous");
    expect(await getPreviousImage(device, "notes-service")).toBeNull();
  });
});
