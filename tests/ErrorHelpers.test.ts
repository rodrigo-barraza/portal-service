import { describe, it, expect } from "vitest";
import { getErrorMessage } from "../src/utils/ErrorHelpers.ts";

describe("ErrorHelpers", () => {
  it("should extract message from Error instance", () => {
    const errorInstance = new Error("Something went wrong");
    const messageResult = getErrorMessage(errorInstance);
    expect(messageResult).toBe("Something went wrong");
  });

  it("should return string directly if error is a string", () => {
    const errorString = "Custom string error";
    const messageResult = getErrorMessage(errorString);
    expect(messageResult).toBe("Custom string error");
  });

  it("should return String representation for other types", () => {
    const errorObject = { code: 500, detail: "Server Error" };
    const messageResult = getErrorMessage(errorObject);
    expect(messageResult).toBe("[object Object]");
  });

  it("should handle null and undefined error values gracefully", () => {
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });
});
