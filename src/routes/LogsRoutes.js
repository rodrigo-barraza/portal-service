// ─── Logs Route ─────────────────────────────────────────────

import { Router } from "express";
import http from "http";
import { PROJECTS, DEVICES } from "../config.js";
import logger from "../utils/logger.js";

const router = Router();

const DOCKER_SOCKET = "/var/run/docker.sock";

/**
 * GET /logs
 * Returns a list of services that support log streaming.
 */
router.get("/", (_req, res) => {
  const loggable = Object.entries(PROJECTS)
    .filter(([, svc]) => svc.dockerProject)
    .map(([id, svc]) => ({
      id,
      name: svc.name,
      dockerProject: svc.dockerProject,
      device: svc.device,
      deviceName: DEVICES[svc.device]?.name || svc.device,
      deployTier: svc.deployTier ?? null,
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
  const svc = PROJECTS[id];

  if (!svc) {
    return res.status(404).json({ error: `Unknown service: ${id}` });
  }

  if (!svc.dockerProject) {
    return res
      .status(400)
      .json({ error: `${svc.name} is not a containerized service` });
  }

  const device = DEVICES[svc.device];
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

  let closed = false;

  function sendLine(line) {
    if (closed) return;
    res.write(`data: ${line}\n\n`);
  }

  function sendError(message) {
    if (closed) return;
    res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
  }

  function cleanup(child) {
    if (closed) return;
    closed = true;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
    res.end();
  }

  // ── Choose strategy: Docker socket (local) or SSH (remote) ──
  if (device?.sshAlias) {
    // NAS or any device with sshAlias — use Docker Engine API via Unix socket
    // when the API container is on the same host (docker.sock is mounted)
    streamViaDockerSocket(svc, tail, follow, sendLine, sendError, () => cleanup(null), req, res);
  } else {
    // No SSH alias, no docker socket — can't stream
    sendError(`No log streaming method available for device: ${svc.device}`);
    cleanup(null);
  }
});

/**
 * Stream logs via Docker Engine API over the mounted Unix socket.
 * This is a direct HTTP request to /containers/<name>/logs.
 */
function streamViaDockerSocket(svc, tail, follow, sendLine, sendError, cleanup, clientReq, clientRes) {
  const container = svc.dockerProject;
  const qs = new URLSearchParams({
    stdout: "1",
    stderr: "1",
    tail: String(tail),
    follow: follow ? "1" : "0",
    timestamps: "1",
  });

  const path = `/containers/${container}/logs?${qs}`;

  logger.info(`[Logs] Docker API → ${path}`);

  const dockerReq = http.request(
    {
      socketPath: DOCKER_SOCKET,
      path,
      method: "GET",
    },
    (dockerRes) => {
      if (dockerRes.statusCode !== 200) {
        let body = "";
        dockerRes.on("data", (chunk) => (body += chunk));
        dockerRes.on("end", () => {
          logger.error(`[Logs] Docker API error ${dockerRes.statusCode}: ${body}`);
          try {
            const parsed = JSON.parse(body);
            sendError(parsed.message || `Docker API error: ${dockerRes.statusCode}`);
          } catch {
            sendError(`Docker API error: ${dockerRes.statusCode}`);
          }
          cleanup();
        });
        return;
      }

      // Docker logs use a multiplexed stream format (8-byte header per frame)
      // when the container is not using TTY mode.
      // Header: [stream_type(1), 0, 0, 0, size(4 big-endian)]
      // We need to strip these headers to get clean log lines.
      let buffer = Buffer.alloc(0);

      dockerRes.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        // Process all complete frames in the buffer
        while (buffer.length >= 8) {
          const frameSize = buffer.readUInt32BE(4);
          const totalFrameSize = 8 + frameSize;

          if (buffer.length < totalFrameSize) break; // Wait for more data

          const payload = buffer.subarray(8, totalFrameSize).toString("utf8");
          buffer = buffer.subarray(totalFrameSize);

          // Split payload into lines and send each
          const lines = payload.split("\n");
          for (const line of lines) {
            if (line.length > 0) sendLine(line);
          }
        }
      });

      dockerRes.on("end", () => {
        logger.info(`[Logs] Docker stream ended for ${svc.name}`);
        if (!clientRes.writableEnded) {
          clientRes.write(`event: end\ndata: ${JSON.stringify({ code: 0 })}\n\n`);
        }
        cleanup();
      });

      dockerRes.on("error", (err) => {
        logger.error(`[Logs] Docker stream error for ${svc.name}: ${err.message}`);
        sendError(err.message);
        cleanup();
      });

      // Client disconnect — abort the Docker API request
      clientReq.on("close", () => {
        logger.info(`[Logs] Client disconnected from ${svc.name} log stream`);
        dockerRes.destroy();
        cleanup();
      });
    },
  );

  dockerReq.on("error", (err) => {
    logger.error(`[Logs] Docker socket error for ${svc.name}: ${err.message}`);
    sendError(err.message);
    cleanup();
  });

  dockerReq.end();
}

export default router;
