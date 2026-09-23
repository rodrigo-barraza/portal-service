// ============================================================
// WatchdogService — dead-man's-switch + down alerting
// ============================================================
// Turns the portal's existing 60s health polling into Discord ALERTS,
// and adds push heartbeats for services where a pull probe can't see
// the failure (lupos-bot's wedged reply queue still answers HTTP 200).
//
// Two monitoring modes, chosen per service via the vault registry's
// `watchdog` field:
// - "push": the service POSTs /watchdog/heartbeat/<token>/<id> every
//   minute. Endpoint semantics are Healthchecks.io-compatible
//   (https://healthchecks.io/docs/), including the /fail variant that
//   reports an explicit failure — so lupos-bot's HeartbeatService works
//   against it unchanged. Silence past the grace window = down.
// - pull (default): consumes the status caches ServiceRegistryService /
//   InfrastructureRegistryService already maintain; sustained unhealthy
//   = down. "off" excludes a service entirely.
//
// Alerts fire on state TRANSITIONS only, with a confirmation window for
// pull targets (no paging on a single blip) and a per-target cooldown
// (no flap spam). Transitions found in one evaluation pass go out as one
// Discord message: a host-wide outage flips dozens of targets at once,
// and one webhook post each ran into Discord's rate limit (5 per 2s) —
// the rejected alerts were lost while their recoveries still fired.
// The watchdog itself has the usual blind spot: it can't report its own
// host going down — that needs a watcher outside the NAS.
// ============================================================

import ServiceRegistryService from "./ServiceRegistryService.ts";
import InfrastructureRegistryService from "./InfrastructureRegistryService.ts";
import {
  PROJECTS,
  WATCHDOG_DISCORD_WEBHOOK_URL,
  WATCHDOG_PUSH_GRACE_MS,
  WATCHDOG_CONFIRM_DOWN_MS,
  WATCHDOG_ALERT_COOLDOWN_MS,
} from "../config.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

export type WatchdogMode = "push" | "pull";
export type WatchdogStatus = "pending" | "up" | "down";

export interface WatchdogState {
  id: string;
  name: string;
  kind: "service" | "infrastructure";
  mode: WatchdogMode;
  status: WatchdogStatus;
  /** Last successful push heartbeat (push mode only), epoch ms. */
  lastHeartbeatAtMs: number | null;
  /** When the current unhealthy stretch started, epoch ms. */
  unhealthySinceMs: number | null;
  /** Whether a down alert was sent for the current down episode. */
  alertedDown: boolean;
  /** Last down alert, epoch ms — enforces the alert cooldown. */
  lastDownAlertAtMs: number | null;
  lastReason: string | null;
}

/** One target's observed health for an evaluation pass. */
interface ObservedTarget {
  id: string;
  name: string;
  kind: "service" | "infrastructure";
  /** null = not yet checked (stays pending). */
  healthy: boolean | null;
  reason: string | null;
}

/**
 * Injectable dependencies so the state machine is unit-testable without
 * Express, the registries, or real webhooks.
 */
export interface WatchdogDeps {
  getPullTargets: () => ObservedTarget[];
  getPushTargetIds: () => Array<{ id: string; name: string }>;
  sendAlert: (message: string) => Promise<void>;
  pushGraceMs: number;
  confirmDownMs: number;
  alertCooldownMs: number;
}

const states = new Map<string, WatchdogState>();

function defaultGetPullTargets(): ObservedTarget[] {
  const services = ServiceRegistryService.list()
    .filter((status) => {
      const project = PROJECTS[status.id];
      // Push targets alert via heartbeat staleness; "off" opts out.
      return project?.watchdog !== "push" && project?.watchdog !== "off";
    })
    .map((status) => ({
      id: status.id,
      name: status.name,
      kind: "service" as const,
      healthy: status.checkedAt === null ? null : status.healthy,
      reason: status.error,
    }));

  const infrastructure = InfrastructureRegistryService.list().map((status) => ({
    id: `infra:${status.id}`,
    name: status.name,
    kind: "infrastructure" as const,
    healthy: status.checkedAt === null ? null : status.healthy,
    reason: status.error,
  }));

  return [...services, ...infrastructure];
}

function defaultGetPushTargetIds(): Array<{ id: string; name: string }> {
  return Object.entries(PROJECTS)
    .filter(([, project]) => project.watchdog === "push")
    .map(([id, project]) => ({ id, name: project.name }));
}

async function defaultSendAlert(message: string): Promise<void> {
  if (!WATCHDOG_DISCORD_WEBHOOK_URL) {
    logger.warn(`[Watchdog] (no webhook configured) ${message}`);
    return;
  }
  const response = await fetch(WATCHDOG_DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`webhook HTTP ${response.status}`);
  }
}

const defaultDeps: WatchdogDeps = {
  getPullTargets: defaultGetPullTargets,
  getPushTargetIds: defaultGetPushTargetIds,
  sendAlert: defaultSendAlert,
  pushGraceMs: WATCHDOG_PUSH_GRACE_MS,
  confirmDownMs: WATCHDOG_CONFIRM_DOWN_MS,
  alertCooldownMs: WATCHDOG_ALERT_COOLDOWN_MS,
};

function ensureState(
  id: string,
  name: string,
  kind: "service" | "infrastructure",
  mode: WatchdogMode,
): WatchdogState {
  let state = states.get(id);
  if (!state) {
    state = {
      id,
      name,
      kind,
      mode,
      status: "pending",
      lastHeartbeatAtMs: null,
      unhealthySinceMs: null,
      alertedDown: false,
      lastDownAlertAtMs: null,
      lastReason: null,
    };
    states.set(id, state);
  }
  state.name = name;
  state.mode = mode;
  return state;
}

// Discord rejects message content over 2000 characters.
const DISCORD_MESSAGE_LIMIT = 2000;

/** Join alert lines into as few messages as fit Discord's content limit. */
export function packAlertMessages(lines: string[], limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  const messages: string[] = [];
  let current = "";
  for (const line of lines) {
    const clipped = line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
    if (current && current.length + 1 + clipped.length > limit) {
      messages.push(current);
      current = clipped;
    } else {
      current = current ? `${current}\n${clipped}` : clipped;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export default class WatchdogService {
  /** Overridable for tests; production uses the defaults. */
  public static deps: WatchdogDeps = defaultDeps;

  /**
   * Record a push heartbeat. `failed` marks an explicit failure report
   * (the Healthchecks /fail variant) — the pusher is alive enough to
   * report, but says something is wrong (e.g. a wedged reply queue).
   * Returns false when the project isn't a registered push target.
   */
  public static recordHeartbeat(
    projectId: string,
    options: { failed?: boolean; reason?: string | null; nowMs?: number } = {},
  ): boolean {
    const target = WatchdogService.deps
      .getPushTargetIds()
      .find((candidate) => candidate.id === projectId);
    if (!target) return false;

    const nowMs = options.nowMs ?? Date.now();
    const state = ensureState(projectId, target.name, "service", "push");

    if (options.failed) {
      state.lastReason = options.reason || "explicit failure report";
      // An explicit /fail is a confirmed problem — alert immediately,
      // no confirmation window. The heartbeat itself still counts as
      // "the process is alive", so staleness tracking resets.
      state.lastHeartbeatAtMs = nowMs;
      void WatchdogService._sendAlerts([
        WatchdogService._transitionDown(state, nowMs, state.lastReason, { immediate: true }),
      ]);
      return true;
    }

    state.lastHeartbeatAtMs = nowMs;
    state.lastReason = options.reason || null;
    void WatchdogService._sendAlerts([WatchdogService._transitionUp(state, nowMs)]);
    return true;
  }

  /**
   * One evaluation pass: age push heartbeats, fold in pull statuses,
   * and fire transition alerts. Called on a 30s interval.
   */
  public static async evaluate(nowMs: number = Date.now()): Promise<void> {
    const { deps } = WatchdogService;
    const alerts: Array<string | null> = [];
    const liveIds = new Set<string>();

    for (const target of deps.getPushTargetIds()) {
      liveIds.add(target.id);
      const state = ensureState(target.id, target.name, "service", "push");
      // Never heartbeated: stays pending — a service that hasn't been
      // cut over yet shouldn't page anyone.
      if (state.lastHeartbeatAtMs === null) continue;

      const silenceMs = nowMs - state.lastHeartbeatAtMs;
      if (silenceMs > deps.pushGraceMs) {
        alerts.push(
          WatchdogService._transitionDown(
            state,
            nowMs,
            `no heartbeat for ${formatDuration(silenceMs)}`,
            // Silence already implies the grace window elapsed — no extra
            // confirmation wait on top.
            { immediate: true },
          ),
        );
      }
      // Fresh heartbeats transition up in recordHeartbeat.
    }

    for (const target of deps.getPullTargets()) {
      liveIds.add(target.id);
      const state = ensureState(target.id, target.name, target.kind, "pull");
      if (target.healthy === null) continue; // not yet checked — pending

      alerts.push(
        target.healthy
          ? WatchdogService._transitionUp(state, nowMs)
          : WatchdogService._transitionDown(state, nowMs, target.reason || "health check failing"),
      );
    }

    // A project removed from the registry (or switched to watchdog "off")
    // stops being tracked instead of showing its last state forever.
    for (const id of states.keys()) {
      if (!liveIds.has(id)) states.delete(id);
    }

    await WatchdogService._sendAlerts(alerts);
  }

  /** Current state list, for the /watchdog route and portal UI. */
  public static getStates(): WatchdogState[] {
    return [...states.values()];
  }

  public static getState(id: string): WatchdogState | null {
    return states.get(id) || null;
  }

  /** Test hook — clears all tracked state. */
  public static _resetForTests(): void {
    states.clear();
    WatchdogService.deps = defaultDeps;
  }

  /** Apply a down observation; returns the alert line to send, if any. */
  private static _transitionDown(
    state: WatchdogState,
    nowMs: number,
    reason: string,
    options: { immediate?: boolean } = {},
  ): string | null {
    const { deps } = WatchdogService;

    if (state.unhealthySinceMs === null) state.unhealthySinceMs = nowMs;
    state.status = "down";
    state.lastReason = reason;

    if (state.alertedDown) return null; // already paged for this episode

    const confirmedMs = nowMs - state.unhealthySinceMs;
    if (!options.immediate && confirmedMs < deps.confirmDownMs) return null;

    const inCooldown =
      state.lastDownAlertAtMs !== null &&
      nowMs - state.lastDownAlertAtMs < deps.alertCooldownMs;
    if (inCooldown) return null;

    state.alertedDown = true;
    state.lastDownAlertAtMs = nowMs;
    return `🔴 **${state.name}** is DOWN — ${reason}`;
  }

  /** Apply an up observation; returns the recovery line to send, if any. */
  private static _transitionUp(state: WatchdogState, nowMs: number): string | null {
    const wasAlerted = state.alertedDown;
    const downForMs =
      state.unhealthySinceMs !== null ? nowMs - state.unhealthySinceMs : 0;

    state.status = "up";
    state.unhealthySinceMs = null;
    state.alertedDown = false;

    // Recovery only pages when the outage itself did — a blip that never
    // alerted recovers silently.
    return wasAlerted ? `🟢 **${state.name}** recovered after ${formatDuration(downForMs)}` : null;
  }

  /** Send a pass's alert lines as few webhook posts as fit; failures are logged, never thrown. */
  private static async _sendAlerts(lines: Array<string | null>): Promise<void> {
    for (const message of packAlertMessages(lines.filter((line): line is string => line !== null))) {
      try {
        await WatchdogService.deps.sendAlert(message);
        logger.warn(`[Watchdog] ${message}`);
      } catch (error: unknown) {
        logger.error(
          `[Watchdog] Failed to send alert (${getErrorMessage(error)}): ${message}`,
        );
      }
    }
  }
}
