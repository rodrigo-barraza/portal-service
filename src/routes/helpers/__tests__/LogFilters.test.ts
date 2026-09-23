import { describe, it, expect } from "vitest";
import {
  createLineSplitter,
  extractLogLevel,
  minimumSeverityFor,
  parseRelativeTimeToUnixSeconds,
  shouldIncludeLine,
  stripAnsiCodes,
} from "../LogFilters.ts";

describe("level detection and filtering", () => {
  const warnLine = "\x1b[33m[12:00:01] WARN  disk almost full\x1b[0m";
  const infoLine = "[12:00:02] INFO  request done";

  it("detects the logger's level token through ANSI colour codes", () => {
    expect(extractLogLevel(stripAnsiCodes(warnLine))).toBe("WARN");
    expect(extractLogLevel(infoLine)).toBe("INFO");
    expect(extractLogLevel("    at Object.<anonymous> (file.ts:1:1)")).toBeNull();
  });

  it("cascades: warn keeps WARN and ERROR, drops INFO, keeps unlevelled lines", () => {
    const minimum = minimumSeverityFor("warn");
    expect(shouldIncludeLine(warnLine, minimum, null)).toBe(true);
    expect(shouldIncludeLine(infoLine, minimum, null)).toBe(false);
    expect(shouldIncludeLine("    at stack frame", minimum, null)).toBe(true);
  });

  it("searches the ANSI-stripped text case-insensitively", () => {
    expect(shouldIncludeLine(warnLine, null, "disk")).toBe(true);
    expect(shouldIncludeLine(warnLine, null, "33m")).toBe(false);
  });

  it("ignores unknown level filters", () => {
    expect(minimumSeverityFor("verbose")).toBeNull();
    expect(minimumSeverityFor("constructor")).toBeNull();
    expect(minimumSeverityFor(null)).toBeNull();
  });
});

describe("parseRelativeTimeToUnixSeconds", () => {
  const now = 1_700_000_000_000;

  it("converts relative windows to a unix timestamp", () => {
    expect(parseRelativeTimeToUnixSeconds("5m", now)).toBe(1_700_000_000 - 300);
    expect(parseRelativeTimeToUnixSeconds("2 h", now)).toBe(1_700_000_000 - 7200);
  });

  it("rejects junk", () => {
    expect(parseRelativeTimeToUnixSeconds("5w", now)).toBeNull();
    expect(parseRelativeTimeToUnixSeconds("yesterday", now)).toBeNull();
  });
});

describe("createLineSplitter", () => {
  it("holds a partial line until its newline arrives, per stream", () => {
    const splitter = createLineSplitter();
    expect(splitter.push("stdout", Buffer.from("first\nsec"))).toEqual(["first"]);
    expect(splitter.push("stderr", Buffer.from("oops\n"))).toEqual(["oops"]);
    expect(splitter.push("stdout", Buffer.from("ond\r\n\nthird"))).toEqual(["second"]);
    expect(splitter.flush()).toEqual([{ streamSource: "stdout", line: "third" }]);
  });

  it("keeps a UTF-8 character split across chunks intact", () => {
    const splitter = createLineSplitter();
    const bytes = Buffer.from("café ✓\n");
    const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte check mark
    expect(splitter.push("stdout", bytes.subarray(0, cut))).toEqual([]);
    expect(splitter.push("stdout", bytes.subarray(cut))).toEqual(["café ✓"]);
  });
});
