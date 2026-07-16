// ─── WatchdogService state-machine tests ────────────────────
// Exercises the dead-man's-switch + alerting logic with injected deps —
// no Express, registries, or webhooks. Scenarios mirror the production
// failure modes: heartbeat silence, explicit /fail reports, sustained
// pull failures, blips that must NOT page, and flap cooldown.

import { describe, it, expect, beforeEach } from "vitest";
import WatchdogService from "../WatchdogService.ts";

const MINUTE = 60_000;
const T0 = 1_000_000_000;

interface PullTarget {
  id: string;
  name: string;
  kind: "service" | "infrastructure";
  healthy: boolean | null;
  reason: string | null;
}

function setup(options: {
  pushTargets?: Array<{ id: string; name: string }>;
  pullTargets?: PullTarget[];
} = {}) {
  const alerts: string[] = [];
  const pullTargets: PullTarget[] = options.pullTargets ?? [];
  WatchdogService.deps = {
    getPullTargets: () => pullTargets,
    getPushTargetIds: () => options.pushTargets ?? [],
    sendAlert: async (message: string) => {
      alerts.push(message);
    },
    pushGraceMs: 4 * MINUTE,
    confirmDownMs: 90_000,
    alertCooldownMs: 10 * MINUTE,
  };
  return { alerts, pullTargets };
}

beforeEach(() => {
  WatchdogService._resetForTests();
});

describe("push heartbeats", () => {
  const PUSH = { pushTargets: [{ id: "lupos-bot", name: "Lupos Bot" }] };

  it("rejects heartbeats from unregistered projects", () => {
    setup(PUSH);
    expect(WatchdogService.recordHeartbeat("unknown-service", { nowMs: T0 })).toBe(false);
    expect(WatchdogService.recordHeartbeat("lupos-bot", { nowMs: T0 })).toBe(true);
  });

  it("never alerts for a push target that has not heartbeated yet", async () => {
    const { alerts } = setup(PUSH);
    await WatchdogService.evaluate(T0);
    await WatchdogService.evaluate(T0 + 60 * MINUTE);
    expect(alerts).toEqual([]);
    expect(WatchdogService.getState("lupos-bot")?.status).toBe("pending");
  });

  it("alerts once when heartbeats go silent past the grace window, then recovers", async () => {
    const { alerts } = setup(PUSH);
    WatchdogService.recordHeartbeat("lupos-bot", { nowMs: T0 });
    expect(WatchdogService.getState("lupos-bot")?.status).toBe("up");

    // Within grace — quiet
    await WatchdogService.evaluate(T0 + 3 * MINUTE);
    expect(alerts).toEqual([]);

    // Past grace — one down alert, not repeated
    await WatchdogService.evaluate(T0 + 5 * MINUTE);
    await WatchdogService.evaluate(T0 + 5.5 * MINUTE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Lupos Bot");
    expect(alerts[0]).toContain("DOWN");
    expect(alerts[0]).toContain("no heartbeat");

    // Heartbeat returns — one recovery alert
    WatchdogService.recordHeartbeat("lupos-bot", { nowMs: T0 + 20 * MINUTE });
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain("recovered");
    expect(WatchdogService.getState("lupos-bot")?.status).toBe("up");
  });

  it("alerts immediately on an explicit /fail report with its reason", async () => {
    const { alerts } = setup(PUSH);
    WatchdogService.recordHeartbeat("lupos-bot", { nowMs: T0 });
    WatchdogService.recordHeartbeat("lupos-bot", {
      failed: true,
      reason: "reply queue wedged: no progress for 320s",
      nowMs: T0 + MINUTE,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("reply queue wedged");

    // Repeated /fail pings while wedged do not re-page
    WatchdogService.recordHeartbeat("lupos-bot", {
      failed: true,
      reason: "reply queue wedged: no progress for 380s",
      nowMs: T0 + 2 * MINUTE,
    });
    expect(alerts).toHaveLength(1);

    // Success ping clears it
    WatchdogService.recordHeartbeat("lupos-bot", { nowMs: T0 + 3 * MINUTE });
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain("recovered");
  });
});

describe("pull targets", () => {
  it("stays pending for never-checked targets", async () => {
    const { alerts } = setup({
      pullTargets: [
        { id: "notes-service", name: "Notes", kind: "service", healthy: null, reason: null },
      ],
    });
    await WatchdogService.evaluate(T0);
    expect(alerts).toEqual([]);
    expect(WatchdogService.getState("notes-service")?.status).toBe("pending");
  });

  it("does not page on a blip shorter than the confirmation window", async () => {
    const { alerts, pullTargets } = setup({
      pullTargets: [
        { id: "notes-service", name: "Notes", kind: "service", healthy: true, reason: null },
      ],
    });
    await WatchdogService.evaluate(T0);

    pullTargets[0].healthy = false;
    pullTargets[0].reason = "HTTP 502";
    await WatchdogService.evaluate(T0 + MINUTE); // unhealthy observed
    expect(alerts).toEqual([]);

    pullTargets[0].healthy = true; // recovered before confirmation
    await WatchdogService.evaluate(T0 + 1.5 * MINUTE);
    expect(alerts).toEqual([]); // silent recovery — never paged
  });

  it("pages after sustained unhealthiness and sends one recovery", async () => {
    const { alerts, pullTargets } = setup({
      pullTargets: [
        { id: "notes-service", name: "Notes", kind: "service", healthy: false, reason: "HTTP 502" },
      ],
    });
    await WatchdogService.evaluate(T0); // first observation — starts the clock
    await WatchdogService.evaluate(T0 + 2 * MINUTE); // past 90s confirmation
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Notes");
    expect(alerts[0]).toContain("HTTP 502");

    pullTargets[0].healthy = true;
    await WatchdogService.evaluate(T0 + 10 * MINUTE);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain("recovered");
  });

  it("suppresses a repeat down alert inside the cooldown window", async () => {
    const { alerts, pullTargets } = setup({
      pullTargets: [
        { id: "notes-service", name: "Notes", kind: "service", healthy: false, reason: "HTTP 502" },
      ],
    });
    await WatchdogService.evaluate(T0);
    await WatchdogService.evaluate(T0 + 2 * MINUTE); // down alert #1
    pullTargets[0].healthy = true;
    await WatchdogService.evaluate(T0 + 3 * MINUTE); // recovery
    expect(alerts).toHaveLength(2);

    // Flaps down again within the 10-minute cooldown — suppressed
    pullTargets[0].healthy = false;
    await WatchdogService.evaluate(T0 + 4 * MINUTE);
    await WatchdogService.evaluate(T0 + 6 * MINUTE);
    expect(alerts).toHaveLength(2);

    // Still down once the cooldown expires — the page fires late, not never
    await WatchdogService.evaluate(T0 + 13 * MINUTE);
    expect(alerts).toHaveLength(3);
    expect(alerts[2]).toContain("DOWN");
  });

  it("tracks infrastructure targets under the infra: prefix", async () => {
    const { alerts } = setup({
      pullTargets: [
        { id: "infra:mongodb", name: "MongoDB", kind: "infrastructure", healthy: false, reason: "connect ECONNREFUSED" },
      ],
    });
    await WatchdogService.evaluate(T0);
    await WatchdogService.evaluate(T0 + 2 * MINUTE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("MongoDB");
    expect(WatchdogService.getState("infra:mongodb")?.status).toBe("down");
  });
});
