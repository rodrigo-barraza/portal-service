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

describe("ScreenshotService browser lifecycle", () => {
  it("launches one Chromium for concurrent first captures", async () => {
    const { chromium } = await import("playwright");
    const page = {
      goto: vi.fn(async () => null),
      waitForLoadState: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => Buffer.from("jpeg")),
    };
    const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
    const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined), on: vi.fn() };
    let finishLaunch!: () => void;
    const launch = vi.mocked(chromium.launch).mockImplementation(
      () => new Promise((resolve) => { finishLaunch = () => resolve(browser as never); }) as never,
    );

    const first = ScreenshotService._captureUncached("prism.example.com");
    const second = ScreenshotService._captureUncached("portal.example.com");
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishLaunch();
    await Promise.all([first, second]);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.newContext).toHaveBeenCalledTimes(2);

    await ScreenshotService.shutdown();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
