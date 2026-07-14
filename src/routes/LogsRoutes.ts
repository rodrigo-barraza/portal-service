import type { ContainerStats } from "../types.ts";
import { Router, Request, Response } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { DEVICES } from "../config.ts";
import DockerStatsService from "../services/DockerStatsService.ts";
import { DockerClient } from "../wrappers/DockerClient.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

const router = Router();

// ─── Log Level Severity Hierarchy ──────────────────────────────
// Higher numeric value = higher severity. Used for cascade filtering:
// requesting "warn" returns WARN + ERROR (anything >= WARN).

type LogLevel = "DEBUG" | "INFO" | "OK" | "WARN" | "ERROR";

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  OK: 1,
  WARN: 2,
  ERROR: 3,
};

const VALID_LEVEL_FILTERS = new Set(["debug", "info", "warn", "error"]);

const LEVEL_FILTER_MINIMUM_SEVERITY: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Matches the logger format: [HH:MM:SS] LEVEL  or ANSI-wrapped equivalent.
// After ANSI stripping, the level token appears after "] " as a padded 5-char word.
const LOG_LEVEL_PATTERN = /\]\s+(ERROR|WARN |INFO |OK {3}|DEBUG)\s/;

// Docker mux stream type (1 = stdout, 2 = stderr)
const DOCKER_STREAM_STDERR = 2;

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function extractLogLevel(rawLine: string): LogLevel | null {
  const strippedLine = stripAnsiCodes(rawLine);
  const match = strippedLine.match(LOG_LEVEL_PATTERN);
  if (!match) return null;
  return match[1].trim() as LogLevel;
}

function parseRelativeTimeToUnixSeconds(relativeTime: string): number | null {
  const match = relativeTime.match(/^(\d+)\s*(s|m|h|d)$/);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  const offsetSeconds = amount * (multipliers[unit] || 0);

  return Math.floor(Date.now() / 1000) - offsetSeconds;
}

function shouldIncludeLine(
  rawLine: string,
  strippedLine: string,
  minimumSeverity: number | null,
  searchTerm: string | null,
): boolean {
  if (minimumSeverity !== null) {
    const detectedLevel = extractLogLevel(rawLine);
    if (detectedLevel) {
      const lineSeverity = LOG_LEVEL_SEVERITY[detectedLevel];
      if (lineSeverity < minimumSeverity) return false;
    }
    // Lines without a detectable level (e.g. stack traces, multiline output)
    // are always included — they typically belong to the preceding log entry.
  }

  if (searchTerm !== null) {
    if (!strippedLine.toLowerCase().includes(searchTerm)) return false;
  }

  return true;
}

// ─── GET / — List loggable containers ──────────────────────────

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

// ─── GET /:containerName — Stream filtered logs ────────────────

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

  // ─── Filter Parameters ───────────────────────────────────────
  const levelFilter = typeof req.query.level === "string" ? req.query.level.toLowerCase() : null;
  const searchFilter = typeof req.query.search === "string" ? req.query.search.toLowerCase() : null;
  const sinceFilter = typeof req.query.since === "string" ? req.query.since : null;

  const minimumSeverity = levelFilter && VALID_LEVEL_FILTERS.has(levelFilter)
    ? LEVEL_FILTER_MINIMUM_SEVERITY[levelFilter]
    : null;

  // Convert relative time (e.g. "5m", "1h") to Docker Engine API `since` unix timestamp
  const sinceTimestamp = sinceFilter ? parseRelativeTimeToUnixSeconds(sinceFilter) : null;

  const isFiltering = minimumSeverity !== null || searchFilter !== null;

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
      level: levelFilter,
      search: searchFilter ? req.query.search : null,
      since: sinceFilter,
    })}\n\n`
  );

  let isClosed = false;
  let totalLineCount = 0;
  let emittedLineCount = 0;

  function sendLine(line: string, streamSource: string) {
    if (isClosed) return;
    res.write(`data: ${JSON.stringify({ line, stream: streamSource })}\n\n`);
  }

  function sendError(message: string) {
    if (isClosed) return;
    res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
  }

  function sendMeta() {
    if (isClosed) return;
    res.write(`event: meta\ndata: ${JSON.stringify({
      totalLines: totalLineCount,
      emittedLines: emittedLineCount,
      filteredOutLines: totalLineCount - emittedLineCount,
      level: levelFilter,
      search: searchFilter ? req.query.search : null,
      since: sinceFilter,
    })}\n\n`);
  }

  if (!deviceEntry.dockerApi) {
    sendError(`No Docker API configured for device: ${matchedContainer.device}`);
    res.end();
    return;
  }

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

  try {
    const dockerRequest = DockerClient.streamLogs(
      deviceEntry,
      String(containerName),
      dockerQueryParameters,
      (payloadChunk: Buffer, streamType: number) => {
        const streamSource = streamType === DOCKER_STREAM_STDERR ? "stderr" : "stdout";
        const payloadLines = payloadChunk.toString("utf8").split("\n");

        for (const line of payloadLines) {
          if (line.length === 0) continue;

          totalLineCount++;

          if (isFiltering) {
            const strippedLine = stripAnsiCodes(line);
            if (!shouldIncludeLine(line, strippedLine, minimumSeverity, searchFilter)) {
              continue;
            }
          }

          emittedLineCount++;
          sendLine(line, streamSource);
        }
      },
      () => {
        logger.info(`[Logs] Docker stream ended for ${containerName}`);
        if (!res.writableEnded) {
          sendMeta();
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
