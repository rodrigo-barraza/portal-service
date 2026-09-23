import { describe, it, expect } from "vitest";
import { parseDfOutput } from "../DockerSystemHelper.ts";

describe("parseDfOutput", () => {
  it("reads the data line of df -B1", () => {
    const output = [
      "Filesystem      1B-blocks         Used    Available Use% Mounted on",
      "overlay     1000000000000 250000000000 750000000000  25% /",
    ].join("\n");
    expect(parseDfOutput(output)).toEqual({
      total: 1_000_000_000_000,
      used: 250_000_000_000,
      available: 750_000_000_000,
      percent: 25,
    });
  });

  it("returns null for unexpected output", () => {
    expect(parseDfOutput("")).toBeNull();
    expect(parseDfOutput("df: /: No such file or directory")).toBeNull();
  });
});
