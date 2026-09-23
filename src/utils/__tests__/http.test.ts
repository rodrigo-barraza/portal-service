import { describe, it, expect } from "vitest";
import type { Request } from "express";
import {
  queryParam,
  routeParam,
  singleValuedQuery,
  wildcardParam,
} from "../http.ts";

function request(parts: {
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
}) {
  return {
    query: parts.query ?? {},
    params: parts.params ?? {},
  } as unknown as Request;
}

describe("wildcardParam", () => {
  it("rejoins Express 5's segment array with '/' (String() would give 'a,b')", () => {
    const req = request({
      params: { objectPath: ["folder", "sub", "file.png"] },
    });
    expect(wildcardParam(req, "objectPath")).toBe("folder/sub/file.png");
  });

  it("keeps an encoded slash inside one segment", () => {
    const req = request({ params: { objectPath: ["dir", "a/b"] } });
    expect(wildcardParam(req, "objectPath")).toBe("dir/a/b");
  });

  it("reads a plain string or nothing", () => {
    expect(
      wildcardParam(
        request({ params: { objectPath: "file.txt" } }),
        "objectPath",
      ),
    ).toBe("file.txt");
    expect(wildcardParam(request({}), "objectPath")).toBe("");
  });
});

describe("queryParam / singleValuedQuery / routeParam", () => {
  it("treats repeated and empty parameters as absent", () => {
    const req = request({ query: { a: "1", b: ["1", "2"], c: "" } });
    expect(queryParam(req, "a")).toBe("1");
    expect(queryParam(req, "b")).toBeUndefined();
    expect(queryParam(req, "c")).toBeUndefined();
    expect(singleValuedQuery(req)).toEqual({ a: "1", c: "" });
  });

  it("reads route params as strings", () => {
    expect(routeParam(request({ params: { id: "prism" } }), "id")).toBe(
      "prism",
    );
    expect(routeParam(request({}), "id")).toBe("");
  });
});
