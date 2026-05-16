// ─── Logs Route ─────────────────────────────────────────────

import { Router, Request, Response } from "express";
import http from "http";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { DEVICES } from "../config.js";
import DockerStatsService from "../services/DockerStatsService.js";
import logger from "../utils/logger.js";

const router = Router();

/**
 * GET /logs
 * Returns a list of all Docker containers across all hosts,
 * regardless of whether they map to a registered project.
 */
router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  try {
    const containers = await DockerStatsService.getAll(undefined);

    const loggable = containers.map((c: any) => ({
      id: c.name,
      name: c.name,
      image: c.image,
      state: c.state,
      status: c.status,
      device: c.device,
      deviceName: DEVICES[c.device]?.name || c.device,
    }));

    res.json({ containers: loggable });
  } catch (error: any) {
    logger.error(`[Logs] Failed to list containers: ${error.message}`);
    res.json({ containers: [] });
  }
}, "Logs_List"));

/**
 * GET /logs/:containerName
 * Streams container logs as Server-Sent Events.
 * :containerName is the Docker container name (e.g. "prism-service", "mongo").
 * Optionally ?device=synology to disambiguate if the same name exists on multiple hosts.
 * Each SSE event is a single log line: `data: <line>\n\n`
 * Sends `event: connected` on handshake and `event: error` on failure.
 */
router.get("/:containerName", asyncHandler(async (req: Request, res: Response) => {
  const { containerName } = req.params;
  const deviceFilter = req.query.device || null;

  // Look up the container in the live stats cache
  let containers;
  try {
    containers = await DockerStatsService.getAll(deviceFilter as string | undefined);
  } catch (error: any) {
    logger.error(`[Logs] Failed to query containers: ${error.message}`);
    return res.status(500).json({ error: "Failed to query Docker containers" });
  }

  const match = containers.find((c: any) => c.name === containerName);

  if (!match) {
    return res.status(404).json({ error: `Container not found: ${containerName}` });
  }

  const device = DEVICES[match.device];
  if (!device) {
    return res.status(400).json({ error: `Unknown device for container: ${match.device}` });
  }

  const tail = Math.min(Math.max(parseInt(req.query.tail as string, 10) || 200, 1), 5000);
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
      container: containerName,
      device: match.device,
      deviceName: device.name,
      tail,
      follow,
    })}\n\n`,
  );

  let closed = false;

  function sendLine(line: string) {
    if (closed) return;
    res.write(`data: ${line}\n\n`);
  }

  function sendError(message: string) {
    if (closed) return;
    res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
  }

  function cleanup(child: any) {
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

  // ── Stream via Docker socket or TCP ──────────────────────────
  if (device.dockerApi) {
    streamViaDockerApi(device, containerName as string, tail, follow, sendLine, sendError, () => cleanup(null), req, res);
  } else {
    sendError(`No Docker API configured for device: ${match.device}`);
    cleanup(null);
  }
}, "Logs_Stream"));

/**
 * Stream logs via Docker Engine API (Unix socket or TCP).
 * This is a direct HTTP request to /containers/<name>/logs.
 */
function streamViaDockerApi(device: any, containerName: string, tail: number, follow: boolean, sendLine: (l: string) => void, sendError: (e: string) => void, cleanup: () => void, clientReq: Request, clientRes: Response) {
  const qs = new URLSearchParams({
    stdout: "1",
    stderr: "1",
    tail: String(tail),
    follow: follow ? "1" : "0",
    timestamps: "1",
  });

  const path = `/containers/${containerName}/logs?${qs}`;

  logger.info(`[Logs] Docker API → ${path}`);

  // Parse transport from device.dockerApi
  let transport;
  if (device.dockerApi.startsWith("unix://")) {
    transport = { socketPath: device.dockerApi.slice(7), path };
  } else if (device.dockerApi.startsWith("tcp://")) {
    const url = new URL(device.dockerApi.replace("tcp://", "http://"));
    transport = {
      hostname: url.hostname,
      port: parseInt(url.port, 10) || 2375,
      path,
    };
  } else {
    sendError(`Unsupported Docker API protocol: ${device.dockerApi}`);
    cleanup();
    return;
  }

  const dockerReq = http.request(
    {
      ...transport,
      method: "GET",
    },
    (dockerRes: any) => {
      if (dockerRes.statusCode !== 200) {
        let body = "";
        dockerRes.on("data", (chunk: any) => (body += chunk));
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

      dockerRes.on("data", (chunk: any) => {
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
        logger.info(`[Logs] Docker stream ended for ${containerName}`);
        if (!clientRes.writableEnded) {
          clientRes.write(`event: end\ndata: ${JSON.stringify({ code: 0 })}\n\n`);
        }
        cleanup();
      });

      dockerRes.on("error", (error: any) => {
        logger.error(`[Logs] Docker stream error for ${containerName}: ${error.message}`);
        sendError(error.message);
        cleanup();
      });

      // Client disconnect — abort the Docker API request
      clientReq.on("close", () => {
        logger.info(`[Logs] Client disconnected from ${containerName} log stream`);
        dockerRes.destroy();
        cleanup();
      });
    },
  );

  dockerReq.on("error", (error: any) => {
    logger.error(`[Logs] Docker socket error for ${containerName}: ${error.message}`);
    sendError(error.message);
    cleanup();
  });

  dockerReq.end();
}

export default router;
