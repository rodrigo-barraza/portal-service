import type { ContainerStats } from "../types.ts";
import { Router, Request, Response } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { DEVICES } from "../config.ts";
import DockerStatsService from "../services/DockerStatsService.ts";
import { DockerClient } from "../wrappers/DockerClient.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

const router = Router();

router.get("/", asyncHandler(async (_req: Request, res: Response) => {
  try {
    const containers = await DockerStatsService.getAll(undefined);

    const loggableContainers = containers.map((container: ContainerStats) => ({
      id: container.name,
      name: container.name,
      image: container.image,
      state: container.state,
      status: container.status,
      device: container.device,
      deviceName: DEVICES[container.device]?.name || container.device,
    }));

    res.json({ containers: loggableContainers });
  } catch (error: unknown) {
    logger.error(`[Logs] Failed to list containers: ${getErrorMessage(error)}`);
    res.json({ containers: [] });
  }
}, "Logs_List"));

router.get("/:containerName", asyncHandler(async (req: Request, res: Response) => {
  const { containerName } = req.params;
  const deviceFilter = typeof req.query.device === "string" ? req.query.device : undefined;

  let containers;
  try {
    containers = await DockerStatsService.getAll(deviceFilter);
  } catch (error: unknown) {
    logger.error(`[Logs] Failed to query containers: ${getErrorMessage(error)}`);
    return res.status(500).json({ error: "Failed to query Docker containers" });
  }

  const matchedContainer = containers.find((container: ContainerStats) => container.name === containerName);

  if (!matchedContainer) {
    return res.status(404).json({ error: `Container not found: ${containerName}` });
  }

  const deviceEntry = DEVICES[matchedContainer.device];
  if (!deviceEntry) {
    return res.status(400).json({ error: `Unknown device for container: ${matchedContainer.device}` });
  }

  const tailString = typeof req.query.tail === "string" ? req.query.tail : "";
  const tailCount = Math.min(Math.max(parseInt(tailString, 10) || 200, 1), 5000);
  const isFollowing = req.query.follow === "1";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(
    `event: connected\ndata: ${JSON.stringify({
      container: containerName,
      device: matchedContainer.device,
      deviceName: deviceEntry.name,
      tail: tailCount,
      follow: isFollowing,
    })}\n\n`
  );

  let isClosed = false;

  function sendLine(line: string) {
    if (isClosed) return;
    res.write(`data: ${line}\n\n`);
  }

  function sendError(message: string) {
    if (isClosed) return;
    res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
  }

  if (!deviceEntry.dockerApi) {
    sendError(`No Docker API configured for device: ${matchedContainer.device}`);
    res.end();
    return;
  }

  try {
    const dockerRequest = DockerClient.streamLogs(
      deviceEntry,
      String(containerName),
      {
        stdout: "1",
        stderr: "1",
        tail: String(tailCount),
        follow: isFollowing ? "1" : "0",
        timestamps: "1",
      },
      (payloadChunk: Buffer) => {
        const payloadLines = payloadChunk.toString("utf8").split("\n");
        for (const line of payloadLines) {
          if (line.length > 0) {
            sendLine(line);
          }
        }
      },
      () => {
        logger.info(`[Logs] Docker stream ended for ${containerName}`);
        if (!res.writableEnded) {
          res.write(`event: end\ndata: ${JSON.stringify({ code: 0 })}\n\n`);
        }
        isClosed = true;
        res.end();
      },
      (error: Error) => {
        logger.error(`[Logs] Docker stream error for ${containerName}: ${error.message}`);
        sendError(error.message);
        isClosed = true;
        res.end();
      }
    );

    req.on("close", () => {
      logger.info(`[Logs] Client disconnected from ${containerName} log stream`);
      isClosed = true;
      dockerRequest.destroy();
    });
  } catch (error: unknown) {
    sendError(getErrorMessage(error));
    res.end();
  }
}, "Logs_Stream"));

export default router;
