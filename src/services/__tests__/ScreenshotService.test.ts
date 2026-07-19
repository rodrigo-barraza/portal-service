// ── ScreenshotService tests ──
// Playwright is mocked out — these cover the domain allowlist and the
// request-coalescing behavior, not actual browser capture.

import { describe, it, expect, vi } from "vitest";

vi.mock("playwright", () => ({ chromium: { launch: vi.fn() } }));

vi.mock("../ServiceRegistryService.ts", () => ({
  default: {
    list: () => [
      { domain: "prism.example.com" },
      { domain: "portal.example.com" },
      { domain: null },
    ],
  },
}));

import ScreenshotService from "../ScreenshotService.ts";
import type { ScreenshotEntry } from "../ScreenshotService.ts";

describe("ScreenshotService.isAllowedDomain", () => {
  it("allows domains registered on a service", () => {
    expect(ScreenshotService.isAllowedDomain("prism.example.com")).toBe(true);
    expect(ScreenshotService.isAllowedDomain("portal.example.com")).toBe(true);
  });

  it("rejects unknown domains", () => {
    expect(ScreenshotService.isAllowedDomain("evil.example.com")).toBe(false);
    expect(ScreenshotService.isAllowedDomain("")).toBe(false);
  });
});

describe("ScreenshotService._capture", () => {
  it("coalesces concurrent captures for the same domain", async () => {
    const entry: ScreenshotEntry = {
      buffer: Buffer.from("jpeg-bytes"),
      capturedAt: 1,
      contentType: "image/jpeg",
    };

    let resolveCapture: (value: ScreenshotEntry) => void;
    const captureSpy = vi
      .spyOn(ScreenshotService, "_captureUncached")
      .mockImplementation(
        () => new Promise((resolve) => { resolveCapture = resolve; }),
      );

    const first = ScreenshotService._capture("prism.example.com");
    const second = ScreenshotService._capture("prism.example.com");
    resolveCapture!(entry);

    expect(await first).toBe(entry);
    expect(await second).toBe(entry);
    expect(captureSpy).toHaveBeenCalledTimes(1);

    captureSpy.mockRestore();
  });

  it("captures again once the previous capture settles", async () => {
    const entry: ScreenshotEntry = {
      buffer: Buffer.from("jpeg-bytes"),
      capturedAt: 1,
      contentType: "image/jpeg",
    };
    const captureSpy = vi
      .spyOn(ScreenshotService, "_captureUncached")
      .mockResolvedValue(entry);

    await ScreenshotService._capture("portal.example.com");
    await ScreenshotService._capture("portal.example.com");

    expect(captureSpy).toHaveBeenCalledTimes(2);
    captureSpy.mockRestore();
  });
});
