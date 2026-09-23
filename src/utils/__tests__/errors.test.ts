import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import { errorHandler, resolveErrorStatus } from "../errors.ts";
import logger from "../logger.ts";

function invoke(error: unknown, { headersSent = false } = {}) {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const next = vi.fn();
  const res = { status, json, headersSent } as unknown as Response;
  errorHandler(error, {} as Request, res, next);
  return { status, json, next };
}

describe("errorHandler middleware", () => {
  beforeEach(() => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hides an unexpected error's text behind a generic 500", () => {
    const { status, json } = invoke(new Error("connect ECONNREFUSED 10.0.0.5:27017"));
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Internal server error" });
  });

  it("exposes a deliberate HttpError's message and status", () => {
    const { status, json } = invoke(new HttpError("Vault returned empty registry", 502));
    expect(status).toHaveBeenCalledWith(502);
    expect(json).toHaveBeenCalledWith({ error: "Vault returned empty registry" });
  });

  it("exposes client errors carried as a plain `status`", () => {
    const error = Object.assign(new Error("Not Authorized"), { status: 401 });
    const { status, json } = invoke(error);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Not Authorized" });
  });

  it("puts the message in `error` — the field the portal's API clients read", () => {
    const { json } = invoke(new HttpError("Invalid bucket name: X", 400));
    const body = json.mock.calls[0][0];
    expect(typeof body.error).toBe("string");
  });

  it("defers to Express once a streaming response has started", () => {
    const error = new Error("stream broke");
    const { status, next } = invoke(error, { headersSent: true });
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(error);
  });
});

describe("resolveErrorStatus", () => {
  it("reads statusCode or status, defaulting to 500", () => {
    expect(resolveErrorStatus(new HttpError("x", 404))).toBe(404);
    expect(resolveErrorStatus({ status: 503 })).toBe(503);
    expect(resolveErrorStatus({ status: 200 })).toBe(500);
    expect(resolveErrorStatus(null)).toBe(500);
  });
});
