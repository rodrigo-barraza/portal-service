// ─── Request Helpers ────────────────────────────────────────

import type { Request } from "express";

/**
 * A single-valued query parameter. Absent, empty, or repeated
 * (`?a=1&a=2` parses to an array) all read as undefined.
 */
export function queryParam(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Every single-valued query parameter, for forwarding to an upstream.
 * Repeated parameters are dropped rather than joined into "a,b".
 */
export function singleValuedQuery(req: Request): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.query)) {
    if (typeof value === "string") query[name] = value;
  }
  return query;
}

/** A route parameter as a string (Express 5 types them loosely). */
export function routeParam(req: Request, name: string): string {
  const value: unknown = req.params[name];
  return typeof value === "string" ? value : "";
}

/**
 * An Express 5 `*name` wildcard parameter. path-to-regexp v8 delivers it
 * as the array of decoded path segments (typed as string) — String() on
 * it yields "a,b,c" — so rejoin the segments with "/".
 */
export function wildcardParam(req: Request, name: string): string {
  const value: unknown = req.params[name];
  if (Array.isArray(value)) return value.join("/");
  return typeof value === "string" ? value : "";
}
