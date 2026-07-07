import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { errorHandler } from "../errors.ts";
import logger from "../logger.ts";
import type { Request, Response } from "express";

describe("errorHandler middleware", () => {
  beforeEach(() => {
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should respond with error details and default to 500 status code", () => {
    const errorInstance = new Error("Something went wrong");
    const requestMock = {} as Request;
    
    const responseStatusSpy = vi.fn().mockReturnThis();
    const responseJsonSpy = vi.fn();
    const responseMock = {
      status: responseStatusSpy,
      json: responseJsonSpy,
    } as unknown as Response;

    const nextMock = vi.fn();

    errorHandler(errorInstance, requestMock, responseMock, nextMock);

    expect(responseStatusSpy).toHaveBeenCalledWith(500);
    expect(responseJsonSpy).toHaveBeenCalledWith({
      error: true,
      message: "Something went wrong",
    });
  });

  it("should respond with the custom status code if present", () => {
    const errorInstance = new Error("Not Authorized") as Error & { status?: number };
    errorInstance.status = 401;
    
    const requestMock = {} as Request;
    
    const responseStatusSpy = vi.fn().mockReturnThis();
    const responseJsonSpy = vi.fn();
    const responseMock = {
      status: responseStatusSpy,
      json: responseJsonSpy,
    } as unknown as Response;

    const nextMock = vi.fn();

    errorHandler(errorInstance, requestMock, responseMock, nextMock);

    expect(responseStatusSpy).toHaveBeenCalledWith(401);
    expect(responseJsonSpy).toHaveBeenCalledWith({
      error: true,
      message: "Not Authorized",
    });
  });
});
