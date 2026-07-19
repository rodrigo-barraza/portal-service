// ── MinioService bucket-usage tests ──
// Cover the Prometheus metrics parser, the JWT generator, the incremental
// parallel scanner, and snapshot caching. No real MinIO involved.

import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("../../config.ts", () => ({
  MINIO_ENDPOINT: "http://127.0.0.1:9000",
  MINIO_ACCESS_KEY: "test-access-key",
  MINIO_SECRET_KEY: "test-secret-key",
}));

import MinioService from "../MinioService.ts";

describe("MinioService._parseBucketMetrics", () => {
  it("parses bytes and object counts per bucket, including scientific notation", () => {
    const usage = MinioService._parseBucketMetrics(
      [
        "# HELP minio_bucket_usage_total_bytes Total bucket size in bytes",
        'minio_bucket_usage_total_bytes{bucket="reels",server="nas:9000"} 1.5e+09',
        'minio_bucket_usage_object_total{bucket="reels",server="nas:9000"} 4200',
        'minio_bucket_usage_total_bytes{bucket="images",server="nas:9000"} 1024',
        'minio_bucket_usage_object_total{bucket="images",server="nas:9000"} 3',
        'minio_node_disk_used_bytes{server="nas:9000"} 999',
      ].join("\n"),
    );

    expect(usage.get("reels")).toEqual({ objectCount: 4200, totalSize: 1.5e9 });
    expect(usage.get("images")).toEqual({ objectCount: 3, totalSize: 1024 });
    expect(usage.size).toBe(2);
  });

  it("takes the max across repeated server labels instead of summing", () => {
    const usage = MinioService._parseBucketMetrics(
      [
        'minio_bucket_usage_object_total{bucket="reels",server="a"} 100',
        'minio_bucket_usage_object_total{bucket="reels",server="b"} 100',
      ].join("\n"),
    );
    expect(usage.get("reels")?.objectCount).toBe(100);
  });

  it("returns an empty map for metrics without bucket usage", () => {
    const usage = MinioService._parseBucketMetrics(
      'minio_node_disk_used_bytes{server="a"} 1',
    );
    expect(usage.size).toBe(0);
  });
});

describe("MinioService._generatePrometheusToken", () => {
  it("produces an HS512 JWT with prometheus issuer and access-key subject", () => {
    const token = MinioService._generatePrometheusToken();
    expect(token).toBeTruthy();

    const [headerPart, payloadPart, signaturePart] = token!.split(".");
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());

    expect(header).toEqual({ alg: "HS512", typ: "JWT" });
    expect(payload.iss).toBe("prometheus");
    expect(payload.sub).toBe("test-access-key");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const expectedSignature = createHmac("sha512", "test-secret-key")
      .update(`${headerPart}.${payloadPart}`)
      .digest("base64url");
    expect(signaturePart).toBe(expectedSignature);
  });
});

describe("MinioService._scanUsageIncremental", () => {
  it("yields every bucket exactly once as scans complete", async () => {
    const countSpy = vi
      .spyOn(MinioService, "_countBucket")
      .mockImplementation(async (name: string) => ({
        objectCount: name.length,
        totalSize: name.length * 10,
      }));

    const seen: string[] = [];
    for await (const result of MinioService._scanUsageIncremental(["a", "bb", "ccc", "dddd", "eeeee", "ffffff"])) {
      seen.push(result.name);
      expect(result.usage.objectCount).toBe(result.name.length);
    }

    expect(seen.sort()).toEqual(["a", "bb", "ccc", "dddd", "eeeee", "ffffff"]);
    expect(countSpy).toHaveBeenCalledTimes(6);
    countSpy.mockRestore();
  });
});

describe("MinioService.getBucketUsage", () => {
  it("caches a metrics snapshot and skips refetching while fresh", async () => {
    const metricsSpy = vi
      .spyOn(MinioService, "_fetchUsageFromMetrics")
      .mockResolvedValue(new Map([["reels", { objectCount: 5, totalSize: 50 }]]));

    const first = await MinioService.getBucketUsage();
    expect(first.source).toBe("metrics");
    expect(first.usage.get("reels")?.objectCount).toBe(5);

    const second = await MinioService.getBucketUsage();
    expect(second).toBe(first);
    expect(metricsSpy).toHaveBeenCalledTimes(1);

    metricsSpy.mockRestore();
  });
});
