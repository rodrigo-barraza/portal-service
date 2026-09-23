// ─── Container Actions ──────────────────────────────────────
// restart / stop / start through the Docker Engine API, shared by the
// registry-level routes (/services/:id/…) and the name-level routes
// (/containers/:name/…).

import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import { DEVICES } from "../../config.ts";
import type { DeviceEntry } from "../../types.ts";
import { DockerClient } from "../../wrappers/DockerClient.ts";
import logger from "../../utils/logger.ts";

export type ContainerAction = "restart" | "stop" | "start";

export const CONTAINER_ACTIONS: readonly ContainerAction[] = ["restart", "stop", "start"];

// Docker container names: alphanumeric start, then [a-zA-Z0-9_.-].
// Anything else could rewrite the Engine API request path or query
// (e.g. a %2F-encoded name).
export const VALID_CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

interface ActionSpec {
  /** Engine API path suffix after /containers/{name}. */
  path: string;
  label: string;
  done: string;
  /** Message for 304 Not Modified (already in the target state), if the action has one. */
  alreadyDone: string | null;
}

const ACTION_SPECS: Record<ContainerAction, ActionSpec> = {
  restart: { path: "/restart?t=10", label: "Restart", done: "Container restarted", alreadyDone: null },
  stop: { path: "/stop?t=10", label: "Stop", done: "Container stopped", alreadyDone: "Container already stopped" },
  start: { path: "/start", label: "Start", done: "Container started", alreadyDone: "Container already running" },
};

/** The Engine API's own `{ message }` from an error body, if any. */
export function tryParseDockerError(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const message = (parsed as { message?: unknown } | null)?.message;
    return typeof message === "string" && message ? message : null;
  } catch {
    return null;
  }
}

/** A registry device that has a Docker API endpoint, or null. */
export function resolveDockerDevice(deviceId: string): { id: string; device: DeviceEntry } | null {
  const device = Object.hasOwn(DEVICES, deviceId) ? DEVICES[deviceId] : undefined;
  if (!device || !device.dockerApi) return null;
  return { id: deviceId, device };
}

/**
 * Run one lifecycle action. Resolves with the user-facing message;
 * throws a 502 HttpError carrying Docker's own error text otherwise.
 */
export async function runContainerAction(
  device: DeviceEntry,
  containerName: string,
  action: ContainerAction,
  logLabel: string = containerName,
): Promise<string> {
  const spec = ACTION_SPECS[action];
  const requestPath = `/containers/${encodeURIComponent(containerName)}${spec.path}`;
  logger.info(`[${spec.label}] ${logLabel} → ${requestPath}`);

  const result = await DockerClient.dockerRequest(device, "POST", requestPath);

  if (result.statusCode === 204 || (result.statusCode === 304 && spec.alreadyDone)) {
    logger.success(`[${spec.label}] ${logLabel} ${action === "stop" ? "stopped" : `${action}ed`}`);
    return result.statusCode === 304 && spec.alreadyDone ? spec.alreadyDone : spec.done;
  }

  const message = tryParseDockerError(result.body) || `Docker API error: ${result.statusCode}`;
  logger.error(`[${spec.label}] Failed for ${logLabel}: ${message}`);
  throw new HttpError(message, 502);
}
