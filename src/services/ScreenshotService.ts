// ─── Site Screenshot Service ────────────────────────────────
// Captures cached thumbnails of registered client domains with
// headless Chromium so the portal's container cards can show a
// static preview instead of mounting N live iframes.
//
// Cache is in-memory (regenerated after restarts): stale entries
// are served immediately while a background refresh runs, so the
// UI never waits on a capture after first load.

import { chromium, type Browser } from "playwright";
import { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } from "../config.ts";
import ServiceRegistryService from "./ServiceRegistryService.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

export interface ScreenshotEntry {
  buffer: Buffer;
  capturedAt: number;
  contentType: "image/jpeg";
}

// Matches the 16:10 card previews in portal-client
const VIEWPORT = { width: 1280, height: 800 };
const JPEG_QUALITY = 70;

const FRESH_TTL_MS = 10 * 60 * 1000; // serve without refresh below this age
const NAVIGATION_TIMEOUT_MS = 15_000;
const SETTLE_DELAY_MS = 2_000; // let SPAs paint after network settles
const MAX_CONCURRENT_CAPTURES = 2;
const BROWSER_IDLE_CLOSE_MS = 5 * 60 * 1000;

const cache = new Map<string, ScreenshotEntry>();
const inflight = new Map<string, Promise<ScreenshotEntry>>();

let browser: Browser | null = null;
let idleCloseTimer: NodeJS.Timeout | null = null;
let activeCaptures = 0;
const captureQueue: Array<() => void> = [];

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  browser = await chromium.launch({
    headless: true,
    // In Docker, system Chromium is used instead of Playwright's bundled browser
    ...(PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && {
      executablePath: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    }),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  logger.info("[Screenshot] Chromium launched");
  return browser;
}

function scheduleIdleClose() {
  if (idleCloseTimer) clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(() => {
    if (activeCaptures > 0) return;
    const closing = browser;
    browser = null;
    closing?.close().catch(() => {});
    logger.info("[Screenshot] Chromium closed after idle period");
  }, BROWSER_IDLE_CLOSE_MS);
  idleCloseTimer.unref?.();
}

async function acquireCaptureSlot() {
  if (activeCaptures < MAX_CONCURRENT_CAPTURES) {
    activeCaptures++;
    return;
  }
  await new Promise<void>((resolve) => captureQueue.push(resolve));
  activeCaptures++;
}

function releaseCaptureSlot() {
  activeCaptures--;
  captureQueue.shift()?.();
}

export default class ScreenshotService {
  /**
   * Only registry-known domains may be captured — the domain arrives
   * from a URL parameter, and this is what stops the endpoint from
   * being used to screenshot arbitrary (or internal) hosts.
   */
  static isAllowedDomain(domain: string) {
    return ServiceRegistryService.list().some(
      (service) => service.domain === domain,
    );
  }

  /**
   * Get a screenshot for a registered domain.
   * Fresh cache hit → returned as-is. Stale hit → returned immediately
   * while a background refresh replaces it. Miss → captured inline.
   */
  static async getScreenshot(domain: string): Promise<ScreenshotEntry> {
    const cached = cache.get(domain);

    if (cached) {
      if (Date.now() - cached.capturedAt > FRESH_TTL_MS) {
        ScreenshotService._capture(domain).catch((error: unknown) => {
          logger.warn(
            `[Screenshot] Background refresh failed for ${domain}: ${getErrorMessage(error)}`,
          );
        });
      }
      return cached;
    }

    return ScreenshotService._capture(domain);
  }

  static async _capture(domain: string): Promise<ScreenshotEntry> {
    const existing = inflight.get(domain);
    if (existing) return existing;

    const capturePromise = ScreenshotService._captureUncached(domain).finally(
      () => inflight.delete(domain),
    );
    inflight.set(domain, capturePromise);
    return capturePromise;
  }

  static async _captureUncached(domain: string): Promise<ScreenshotEntry> {
    await acquireCaptureSlot();
    const startedAt = Date.now();

    try {
      const context = await (await getBrowser()).newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });

      try {
        const page = await context.newPage();
        await page.goto(`https://${domain}`, {
          waitUntil: "load",
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        // SPAs fire `load` before they paint — wait for the network to go
        // quiet (best-effort), then a short settle for rendering.
        await page
          .waitForLoadState("networkidle", { timeout: NAVIGATION_TIMEOUT_MS })
          .catch(() => {});
        await page.waitForTimeout(SETTLE_DELAY_MS);

        const buffer = await page.screenshot({
          type: "jpeg",
          quality: JPEG_QUALITY,
        });

        const entry: ScreenshotEntry = {
          buffer,
          capturedAt: Date.now(),
          contentType: "image/jpeg",
        };
        cache.set(domain, entry);
        logger.info(
          `[Screenshot] Captured ${domain} in ${Date.now() - startedAt}ms (${Math.round(buffer.length / 1024)}KB)`,
        );
        return entry;
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      releaseCaptureSlot();
      scheduleIdleClose();
    }
  }
}
