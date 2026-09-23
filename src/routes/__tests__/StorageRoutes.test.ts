// ── StorageRoutes over real HTTP ──
// MinIO is mocked; Express 5's routing is real — that is where nested
// object keys used to arrive as "folder,sub,file.png".

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import http, { type Server } from "node:http";
import express from "express";

const minio = vi.hoisted(() => ({
  statObject: vi.fn(),
  getObject: vi.fn(),
  getPartialObject: vi.fn(),
  deleteObject: vi.fn(),
  listObjects: vi.fn(),
  searchObjects: vi.fn(),
  listBuckets: vi.fn(),
  streamBuckets: vi.fn(),
}));
vi.mock("../../services/MinioService.ts", () => ({ default: minio }));

import storageRouter from "../StorageRoutes.ts";
import { errorHandler } from "../../utils/errors.ts";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const app = express();
  app.use("/object-store", storageRouter);
  app.use(errorHandler);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}/object-store`;
});

afterAll(() => {
  server.close();
});

/** GET with the path sent verbatim — fetch() would resolve "%2E%2E" client-side. */
function rawGetStatus(path: string): Promise<number> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    http
      .get({ host: "localhost", port, path }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  minio.statObject.mockResolvedValue({
    size: 11,
    etag: "abc123",
    lastModified: new Date("2026-09-01T00:00:00Z"),
    metaData: { "content-type": "text/html" },
  });
  minio.getObject.mockImplementation(async () =>
    Readable.from([Buffer.from("hello world")]),
  );
  minio.getPartialObject.mockImplementation(async () =>
    Readable.from([Buffer.from("world")]),
  );
});

describe("nested object keys", () => {
  it("stat receives the key with its slashes intact", async () => {
    const response = await fetch(
      `${baseUrl}/buckets/images/stat/folder/sub/file%20one.png`,
    );
    expect(response.status).toBe(200);
    expect(minio.statObject).toHaveBeenCalledWith(
      "images",
      "folder/sub/file one.png",
    );
    const body = (await response.json()) as { object: string };
    expect(body.object).toBe("folder/sub/file one.png");
  });

  it("delete targets the real key, not a comma-joined one", async () => {
    minio.deleteObject.mockResolvedValue(undefined);
    const response = await fetch(`${baseUrl}/buckets/images/2026/09/a.png`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(minio.deleteObject).toHaveBeenCalledWith("images", "2026/09/a.png");
  });

  it("rejects traversal segments before MinIO sees them", async () => {
    expect(
      await rawGetStatus("/object-store/buckets/images/stat/a/%2E%2E/b"),
    ).toBe(400);
    expect(
      await rawGetStatus("/object-store/buckets/images/stat/a/../../other/key"),
    ).toBe(400);
    expect(minio.statObject).not.toHaveBeenCalled();
  });

  it("maps a missing key to 404 with a string error", async () => {
    minio.statObject.mockRejectedValue(
      Object.assign(new Error("Not Found"), { code: "NotFound" }),
    );
    const response = await fetch(`${baseUrl}/buckets/images/stat/missing.png`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Object not found" });
  });
});

describe("download", () => {
  it("streams the object with safe headers", async () => {
    const response = await fetch(
      `${baseUrl}/buckets/images/download/pages/index.html?inline=true`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello world");
    expect(response.headers.get("content-disposition")).toContain(
      `inline; filename="index.html"`,
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // Inline HTML must not run as this origin
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("etag")).toBe(`"abc123"`);
  });

  it("serves a single byte range", async () => {
    const response = await fetch(`${baseUrl}/buckets/images/download/a/b.txt`, {
      headers: { Range: "bytes=6-10" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 6-10/11");
    expect(minio.getPartialObject).toHaveBeenCalledWith(
      "images",
      "a/b.txt",
      6,
      5,
    );
  });

  it("answers an unsatisfiable range with 416", async () => {
    const response = await fetch(`${baseUrl}/buckets/images/download/a.txt`, {
      headers: { Range: "bytes=50-" },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */11");
  });
});

describe("validation", () => {
  it("rejects a malformed bucket name with 400", async () => {
    const response = await fetch(`${baseUrl}/buckets/Bad_Bucket`);
    expect(response.status).toBe(400);
    expect(minio.listObjects).not.toHaveBeenCalled();
  });

  it("clamps a junk search limit instead of scanning unbounded", async () => {
    minio.searchObjects.mockResolvedValue({
      results: [],
      totalScanned: 0,
      truncated: false,
    });
    await fetch(`${baseUrl}/search?query=cat&limit=abc`);
    expect(minio.searchObjects).toHaveBeenCalledWith("cat", {
      bucket: undefined,
      limit: 200,
    });
  });

  it("hides an unexpected MinIO failure behind a generic 500", async () => {
    minio.listObjects.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.1.2.3:9000"),
    );
    const response = await fetch(`${baseUrl}/buckets/images`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });
});
