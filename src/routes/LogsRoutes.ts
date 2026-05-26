import type { ContainerStats, DeviceEntry } from "../types.ts";
// ─── Logs Route ─────────────────────────────────────────────

import { Router, Request, Response } from "express";
import http from "http";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { DEVICES } from "../config.ts";
import DockerStatsService from "../services/DockerStatsService.ts";
import logger from "../utils/logger.ts";

const router = Router();

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  try {
    const containers = await DockerStatsService.getAll(undefined);

    const loggable = containers.map((container: ContainerStats) => ({
      id: container.name,
      name: container.name,
      image: container.image,
      state: container.state,
      status: container.status,
      device: container.device,
      deviceName: DEVICES[container.device]?.name || container.device,
    }));

    res.json({ containers: loggable });
  } catch (error: unknown) {
    logger.error(`[Logs] Failed to list containers: ${(error as Error).message}`);
    res.json({ containers: [] });
  }
}, "Logs_List"));

router.get("/:containerName", asyncHandler(async (req: Request, res: Response) => {
  const { containerName } = req.params;
  const deviceFilter = typeof req.query.device === "string" ? req.query.device : undefined;

  // Look up the container in the live stats cache
  let containers;
  try {
    containers = await DockerStatsService.getAll(deviceFilter);
  } catch (error: unknown) {
    logger.error(`[Logs] Failed to query containers: ${(error as Error).message}`);
    return res.status(500).json({ error: "Failed to query Docker containers" });
  }

  const match = containers.find((container: ContainerStats) => container.name === containerName);

  if (!match) {
    return res.status(404).json({ error: `Container not found: ${containerName}` });
  }

  const device = DEVICES[match.device];
  if (!device) {
    return res.status(400).json({ error: `Unknown device for container: ${match.device}` });
  }

  const tailStr = typeof req.query.tail === "string" ? req.query.tail : "";
  const tail = Math.min(Math.max(parseInt(tailStr, 10) || 200, 1), 5000);
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

  function cleanup(child?: { kill: (signal?: string) => void; killed: boolean; stdout?: { destroy: () => void }; stderr?: { destroy: () => void } } | null) {
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
    const safeContainerName = typeof containerName === "string" ? containerName : String(containerName);
    streamViaDockerApi(device, safeContainerName, tail, follow, sendLine, sendError, () => cleanup(null), req, res);
  } else {
    sendError(`No Docker API configured for device: ${match.device}`);
    cleanup(null);
  }
}, "Logs_Stream"));

function streamViaDockerApi(device: DeviceEntry, containerName: string, tail: number, follow: boolean, sendLine: (line: string) => void, sendError: (error: string) => void, cleanup: () => void, clientReq: Request, clientRes: Response) {
  const queryString = new URLSearchParams({
    stdout: "1",
    stderr: "1",
    tail: String(tail),
    follow: follow ? "1" : "0",
    timestamps: "1",
  });

  const path = `/containers/${containerName}/logs?${queryString}`;

  logger.info(`[Logs] Docker API → ${path}`);

  if (!device.dockerApi) {
    sendError(`No Docker API configured for device`);
    cleanup();
    return;
  }

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
    (dockerRes: import("http").IncomingMessage) => {
      if (dockerRes.statusCode !== 200) {
        let body = "";
        dockerRes.on("data", (chunk: Buffer) => (body += chunk));
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

      dockerRes.on("data", (chunk: Buffer) => {
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

      dockerRes.on("error", (error: unknown) => {
        const typedError = error as Error;
        logger.error(`[Logs] Docker stream error for ${containerName}: ${err.message}`);
        sendError(err.message);
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

  dockerReq.on("error", (error: unknown) => {
    const errorObject = error as Error;
    logger.error(`[Logs] Docker socket error for ${containerName}: ${errorObject.message}`);
    sendError(errorObject.message);
    cleanup();
  });

  dockerReq.end();
}

export default router;
