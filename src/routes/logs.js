// ============================================================
// Portal API — Logs Route
// ============================================================
// GET /logs             — List services that support log streaming.
// GET /logs/:id         — Stream container logs via SSE over SSH.
//                         Query params:
//                           tail=<n>   — number of historical lines (default 200)
//                           follow=1   — keep connection open for live tailing
// Only works for services with `dockerProject` on a device
// that has an `sshAlias`.
// ============================================================

import { Router } from "express";
import { spawn } from "child_process";
import { SERVICES, DEVICES } from "../config.js";
import logger from "../utils/logger.js";

const router = Router();

/**
 * GET /logs
 * Returns a list of services that support log streaming.
 */
router.get("/", (_req, res) => {
  const loggable = Object.entries(SERVICES)
    .filter(([, svc]) => svc.dockerProject)
    .map(([id, svc]) => ({
      id,
      name: svc.name,
      dockerProject: svc.dockerProject,
      device: svc.device,
      deviceName: DEVICES[svc.device]?.name || svc.device,
    }));

  res.json({ services: loggable });
});

/**
 * GET /logs/:id
 * Streams container logs as Server-Sent Events.
 * Each SSE event is a single log line: `data: <line>\n\n`
 * Sends `event: connected` on handshake and `event: error` on failure.
 */
router.get("/:id", (req, res) => {
  const { id } = req.params;
  const svc = SERVICES[id];

  if (!svc) {
    return res.status(404).json({ error: `Unknown service: ${id}` });
  }

  if (!svc.dockerProject) {
    return res
      .status(400)
      .json({ error: `${svc.name} is not a containerized service` });
  }

  const device = DEVICES[svc.device];
  if (!device?.sshAlias) {
    return res
      .status(400)
      .json({ error: `No SSH access configured for device: ${svc.device}` });
  }

  const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 200, 1), 5000);
  const follow = req.query.follow === "1";

  // ── SSE headers ──────────────────────────────────────────────
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Handshake event
  res.write(
    `event: connected\ndata: ${JSON.stringify({
      service: svc.name,
      container: svc.dockerProject,
      tail,
      follow,
    })}\n\n`,
  );

  // ── Spawn SSH → docker logs ──────────────────────────────────
  const dockerBin = device.dockerBin || "docker";
  const followFlag = follow ? " --follow" : "";
  const sshCmd = `sudo ${dockerBin} logs --tail ${tail}${followFlag} --timestamps ${svc.dockerProject}`;

  logger.info(
    `[Logs] Streaming ${svc.name} → ssh ${device.sshAlias} "${sshCmd}"`,
  );

  const child = spawn(
    "ssh",
    [
      "-o", "ConnectTimeout=5",
      "-o", "BatchMode=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      device.sshAlias,
      sshCmd,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let closed = false;

  function sendLine(line) {
    if (closed) return;
    res.write(`data: ${line}\n\n`);
  }

  function sendError(message) {
    if (closed) return;
    res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
  }

  // Both stdout and stderr carry log output (docker logs writes to stderr for container stderr)
  function handleData(chunk) {
    const text = chunk.toString("utf8");
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.length > 0) sendLine(line);
    }
  }

  child.stdout.on("data", handleData);
  child.stderr.on("data", handleData);

  child.on("error", (err) => {
    logger.error(`[Logs] SSH spawn error for ${svc.name}: ${err.message}`);
    sendError(err.message);
    cleanup();
  });

  child.on("close", (code) => {
    if (!closed) {
      logger.info(`[Logs] Stream ended for ${svc.name} (exit ${code})`);
      res.write(`event: end\ndata: ${JSON.stringify({ code })}\n\n`);
      cleanup();
    }
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    res.end();
  }

  // Client disconnect
  req.on("close", () => {
    logger.info(`[Logs] Client disconnected from ${svc.name} log stream`);
    cleanup();
  });
});

export default router;
