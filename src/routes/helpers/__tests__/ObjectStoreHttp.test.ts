import { describe, it, expect } from "vitest";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import {
  assertValidBucketName,
  assertValidObjectName,
  contentDisposition,
  guessMime,
  isScriptableContentType,
  parseRangeHeader,
  toObjectStoreError,
} from "../ObjectStoreHttp.ts";

describe("assertValidBucketName", () => {
  it("accepts the registry's bucket names", () => {
    for (const name of ["discord-media", "images", "rod-dev-assets", "reel"]) {
      expect(() => assertValidBucketName(name)).not.toThrow();
    }
  });

  it("rejects malformed names with a 400", () => {
    for (const name of [
      "",
      "ab",
      "UPPER",
      "-lead",
      "trail-",
      "a..b",
      "a/b",
      "x".repeat(64),
    ]) {
      expect(() => assertValidBucketName(name)).toThrow(HttpError);
    }
  });
});

describe("assertValidObjectName", () => {
  it("accepts nested keys", () => {
    expect(() =>
      assertValidObjectName("2026/09/photo.final.png"),
    ).not.toThrow();
    expect(() => assertValidObjectName("a,b (1).txt")).not.toThrow();
  });

  it("rejects empty, traversal, and NUL keys", () => {
    for (const name of [
      "",
      "..",
      "../other-bucket/key",
      "a/./b",
      "a/../b",
      "a\0b",
      "x".repeat(1025),
    ]) {
      expect(() => assertValidObjectName(name)).toThrow(HttpError);
    }
  });
});

describe("contentDisposition", () => {
  it("keeps plain names readable", () => {
    expect(contentDisposition("attachment", "report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it("cannot be broken out of by quotes, backslashes, or CRLF", () => {
    const header = contentDisposition(
      "inline",
      'a"b\\c\r\nSet-Cookie: x=1.txt',
    );
    expect(header).not.toMatch(/[\r\n]/);
    const quoted = /filename="([^"]*)"/.exec(header)?.[1];
    expect(quoted).toBe("a_b_c__Set-Cookie: x=1.txt");
  });

  it("percent-encodes RFC 5987 delimiters and non-ASCII in filename*", () => {
    const header = contentDisposition("attachment", "it's (café)*.txt");
    expect(header).toContain(
      `filename*=UTF-8''it%27s%20%28caf%C3%A9%29%2A.txt`,
    );
    expect(header).toContain(`filename="it's (caf_)*.txt"`);
  });

  it("falls back to 'download' without a name", () => {
    expect(contentDisposition("attachment", undefined)).toContain(
      `filename="download"`,
    );
  });
});

describe("parseRangeHeader", () => {
  it("serves the whole object without a usable header", () => {
    expect(parseRangeHeader(undefined, 100)).toEqual({ kind: "none" });
    expect(parseRangeHeader("bytes=0-1,5-6", 100)).toEqual({ kind: "none" });
    expect(parseRangeHeader("items=0-5", 100)).toEqual({ kind: "none" });
  });

  it("parses open, closed, and suffix ranges", () => {
    expect(parseRangeHeader("bytes=0-", 100)).toEqual({
      kind: "range",
      start: 0,
      end: 99,
    });
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual({
      kind: "range",
      start: 10,
      end: 19,
    });
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({
      kind: "range",
      start: 90,
      end: 99,
    });
    expect(parseRangeHeader("bytes=90-500", 100)).toEqual({
      kind: "range",
      start: 90,
      end: 99,
    });
  });

  it("flags unsatisfiable ranges", () => {
    expect(parseRangeHeader("bytes=100-", 100)).toEqual({
      kind: "unsatisfiable",
    });
    expect(parseRangeHeader("bytes=20-10", 100)).toEqual({
      kind: "unsatisfiable",
    });
    expect(parseRangeHeader("bytes=-0", 100)).toEqual({
      kind: "unsatisfiable",
    });
  });
});

describe("guessMime / isScriptableContentType", () => {
  it("infers by extension, case-insensitively", () => {
    expect(guessMime("clip.MP4")).toBe("video/mp4");
    expect(guessMime("dir.v2/README")).toBe("application/octet-stream");
    expect(guessMime(null)).toBe("application/octet-stream");
  });

  it("flags the types a browser runs script in", () => {
    expect(isScriptableContentType("text/html; charset=utf-8")).toBe(true);
    expect(isScriptableContentType("image/svg+xml")).toBe(true);
    expect(isScriptableContentType("image/png")).toBe(false);
    expect(isScriptableContentType("video/mp4")).toBe(false);
  });
});

describe("toObjectStoreError", () => {
  it("maps missing buckets/keys to 404 and bad names to 400", () => {
    const missingKey = toObjectStoreError(
      Object.assign(new Error("Not Found"), { code: "NotFound" }),
    );
    expect(missingKey).toBeInstanceOf(HttpError);
    expect((missingKey as HttpError).statusCode).toBe(404);

    const missingBucket = toObjectStoreError(
      Object.assign(new Error("x"), { code: "NoSuchBucket" }),
    );
    expect((missingBucket as HttpError).message).toBe("Bucket not found");

    const badName = toObjectStoreError(
      Object.assign(new Error("Invalid bucket name: X"), {
        name: "InvalidBucketNameError",
      }),
    );
    expect((badName as HttpError).statusCode).toBe(400);
  });

  it("passes unexpected errors through untouched", () => {
    const connectionError = new Error("connect ECONNREFUSED");
    expect(toObjectStoreError(connectionError)).toBe(connectionError);
  });
});
