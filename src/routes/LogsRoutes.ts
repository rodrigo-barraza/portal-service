// ─── Logs Routes ────────────────────────────────────────────
// Container list + filtered SSE log streams from the Docker Engine API.
// SSE frames: `event: connected` → `data: {line, stream}`… → `event: meta`
// → `event: end` (or `event: error`); `: ping` comments keep followed
// streams alive through proxies.

import type { ClientRequest } from "node:http";
import { Router, type Request, type Response } from "express";
import { createSseEmitter, initSseResponse, startSseHeartbeat } from "@rodrigo-barraza/utilities-library/express";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import { DEVICES } from "../config.ts";
import type { ContainerStats } from "../types.ts";
import DockerStatsService from "../services/DockerStatsService.ts";
import { VALID_CONTAINER_NAME_PATTERN } from "../services/docker/ContainerActions.ts";
import { DockerClient } from "../wrappers/DockerClient.ts";
import logger from "../utils/logger.ts";
import { queryParam, routeParam } from "../utils/http.ts";
import {
  createLineSplitter,
  minimumSeverityFor,
  parseRelativeTimeToUnixSeconds,
  shouldIncludeLine,
} from "./helpers/LogFilters.ts";

const router = Router();

// Docker mux stream type (1 = stdout, 2 = stderr)
const DOCKER_STREAM_STDERR = 2;
const DEFAULT_TAIL = 200;
const MAX_TAIL = 5000;

// ─── GET / — List loggable containers ──────────────────────────

router.get("/", async (_req: Request, res: Response) => {
  let containers: ContainerStats[] = [];
  try {
    containers = await DockerStatsService.getAll();
  } catch (error: unknown) {
    // The list degrades to empty rather than failing the Logs page
    logger.error(`[Logs] Failed to list containers: ${getErrorMessage(error)}`);
  }

  res.json({
    containers: containers.map((container) => ({
      id: container.name,
      name: container.name,
      image: container.image,
      state: container.state,
      status: container.status,
      device: container.device,
      deviceName: DEVICES[container.device]?.name || container.device,
    })),
  });
});

// ─── GET /:containerName — Stream filtered logs ────────────────

router.get("/:containerName", async (req: Request, res: Response) => {
  const containerName = routeParam(req, "containerName");
  if (!VALID_CONTAINER_NAME_PATTERN.test(containerName)) {
    throw new HttpError("Invalid container name", 400);
  }

  let containers: ContainerStats[];
  try {
    containers = await DockerStatsService.getAll(queryParam(req, "device"));
  } catch (error: unknown) {
    logger.error(`[Logs] Failed to query containers: ${getErrorMessage(error)}`);
    throw new HttpError("Failed to query Docker containers", 500);
  }

  const matchedContainer = containers.find((container) => container.name === containerName);
  if (!matchedContainer) {
    throw new HttpError(`Container not found: ${containerName}`, 404);
  }

  const deviceEntry = DEVICES[matchedContainer.device];
  if (!deviceEntry?.dockerApi) {
    throw new HttpError(`No Docker API configured for device: ${matchedContainer.device}`, 400);
  }

  const tailCount = Math.min(Math.max(Number.parseInt(queryParam(req, "tail") ?? "", 10) || DEFAULT_TAIL, 1), MAX_TAIL);
  const isFollowing = req.query.follow === "1";

  // ─── Filter Parameters ───────────────────────────────────────
  const rawSearch = queryParam(req, "search") ?? null;
  const levelFilter = queryParam(req, "level")?.toLowerCase() ?? null;
  const searchFilter = rawSearch?.toLowerCase() ?? null;
  const sinceFilter = queryParam(req, "since") ?? null;
  const minimumSeverity = minimumSeverityFor(levelFilter);
  const sinceTimestamp = sinceFilter ? parseRelativeTimeToUnixSeconds(sinceFilter) : null;
  const isFiltering = minimumSeverity !== null || searchFilter !== null;

  initSseResponse(res);

  // Registered before any await: a client that leaves while the TTY
  // inspect is in flight must still tear the Docker stream down, or a
  // followed stream would run (and hold a Docker connection) forever.
  let clientGone = false;
  let finished = false;
  let dockerStream: ClientRequest | null = null;
  const stopHeartbeat = isFollowing ? startSseHeartbeat(res) : () => {};

  res.on("close", () => {
    clientGone = true;
    stopHeartbeat();
    if (dockerStream) {
      logger.info(`[Logs] Client disconnected from ${containerName} log stream`);
      dockerStream.destroy();
    }
  });

  const writeEvent = (event: string, payload: unknown) => {
    if (clientGone || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const emitDataFrame = createSseEmitter(res);

  let totalLineCount = 0;
  let emittedLineCount = 0;

  const finish = (outcome: { error: string } | null) => {
    if (finished) return;
    finished = true;
    stopHeartbeat();
    if (outcome) {
      writeEvent("error", outcome);
    } else {
      writeEvent("meta", {
        totalLines: totalLineCount,
        emittedLines: emittedLineCount,
        filteredOutLines: totalLineCount - emittedLineCount,
        level: levelFilter,
        search: rawSearch,
        since: sinceFilter,
      });
      writeEvent("end", { code: 0 });
    }
    if (!res.writableEnded) res.end();
  };

  writeEvent("connected", {
    container: containerName,
    device: matchedContainer.device,
    deviceName: deviceEntry.name,
    tail: tailCount,
    follow: isFollowing,
    level: levelFilter,
    search: rawSearch,
    since: sinceFilter,
  });

  // TTY containers stream raw output (no stdout/stderr mux framing) —
  // the parser must know which mode to use before connecting.
  let isTty = false;
  try {
    const inspect = await DockerClient.dockerGetJson<{ Config?: { Tty?: boolean } }>(
      deviceEntry,
      `/containers/${encodeURIComponent(containerName)}/json`,
    );
    isTty = inspect.Config?.Tty === true;
  } catch {
    // Inspect failure: assume non-TTY (the overwhelmingly common case)
  }

  if (clientGone) return;

  const dockerQueryParameters: Record<string, string> = {
    stdout: "1",
    stderr: "1",
    tail: String(tailCount),
    follow: isFollowing ? "1" : "0",
    timestamps: "1",
  };
  if (sinceTimestamp !== null) {
    dockerQueryParameters.since = String(sinceTimestamp);
  }

  const lineSplitter = createLineSplitter();
  const processLine = (line: string, streamSource: string) => {
    totalLineCount++;
    if (isFiltering && !shouldIncludeLine(line, minimumSeverity, searchFilter)) return;
    emittedLineCount++;
    emitDataFrame({ line, stream: streamSource });
  };

  try {
    dockerStream = DockerClient.streamLogs(
      deviceEntry,
      containerName,
      dockerQueryParameters,
      isTty,
      (payloadChunk: Buffer, streamType: number) => {
        const streamSource = streamType === DOCKER_STREAM_STDERR ? "stderr" : "stdout";
        for (const line of lineSplitter.push(streamSource, payloadChunk)) {
          processLine(line, streamSource);
        }
      },
      () => {
        for (const { streamSource, line } of lineSplitter.flush()) {
          processLine(line, streamSource);
        }
        finish(null);
      },
      (error: Error) => {
        // Our own destroy() on disconnect surfaces here too — not a failure
        if (clientGone) return;
        logger.error(`[Logs] Docker stream error for ${containerName}: ${error.message}`);
        finish({ error: error.message });
      },
    );
  } catch (error: unknown) {
    finish({ error: getErrorMessage(error) });
  }
});

export default router;
