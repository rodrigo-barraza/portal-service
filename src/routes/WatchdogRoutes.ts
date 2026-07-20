// ─── Watchdog Routes ────────────────────────────────────────
// Push-heartbeat receiver + watchdog state readout.
//
// The heartbeat endpoints implement Healthchecks.io-compatible ping
// semantics (https://healthchecks.io/docs/): POST (or GET) to the base
// path means "alive", the /fail variant reports an explicit failure with
// the request body as reason. The path token authorizes pushes without
// requiring pushers to set auth headers — the URL is the secret, exactly
// like a Healthchecks ping URL or Kuma push token.

import express, { Router, type Request, type Response } from "express";
import WatchdogService from "../services/WatchdogService.ts";
import { WATCHDOG_PUSH_TOKEN } from "../config.ts";

const router = Router();

// Heartbeat bodies are plain-text reasons (e.g. "ok", a wedge report) —
// the global express.json() skips them, so parse text on this router.
router.use(express.text({ type: "*/*", limit: "4kb" }));

function handleHeartbeat(failed: boolean) {
  return (req: Request, res: Response) => {
    if (!WATCHDOG_PUSH_TOKEN) {
      res
        .status(503)
        .json({ error: "watchdog push token not configured" });
      return;
    }
    if (String(req.params.token) !== WATCHDOG_PUSH_TOKEN) {
      res.status(403).json({ error: "invalid token" });
      return;
    }

    const projectId = String(req.params.projectId);
    const reason = typeof req.body === "string" ? req.body.slice(0, 500) : null;
    const accepted = WatchdogService.recordHeartbeat(projectId, {
      failed,
      reason,
    });

    if (!accepted) {
      res
        .status(404)
        .json({ error: `"${req.params.projectId}" is not a push watchdog target` });
      return;
    }
    res.json({ ok: true });
  };
}

// POST is what HeartbeatService sends; GET supported for curl/browser tests.
router.post("/heartbeat/:token/:projectId", handleHeartbeat(false));
router.get("/heartbeat/:token/:projectId", handleHeartbeat(false));
router.post("/heartbeat/:token/:projectId/fail", handleHeartbeat(true));
router.get("/heartbeat/:token/:projectId/fail", handleHeartbeat(true));

// Watchdog state readout — consumed by the portal UI and for debugging.
router.get("/", (_req: Request, res: Response) => {
  const states = WatchdogService.getStates().map((state) => ({
    id: state.id,
    name: state.name,
    kind: state.kind,
    mode: state.mode,
    status: state.status,
    lastHeartbeatAt:
      state.lastHeartbeatAtMs !== null
        ? new Date(state.lastHeartbeatAtMs).toISOString()
        : null,
    downSince:
      state.unhealthySinceMs !== null
        ? new Date(state.unhealthySinceMs).toISOString()
        : null,
    alerted: state.alertedDown,
    lastReason: state.lastReason,
  }));
  res.json({ states });
});

export default router;
