// ─── Container Rollback ─────────────────────────────────────
// Every deploy re-tags the outgoing image as `<image>:previous`. A
// rollback swaps `:latest` and `:previous` (by image ID, so a failure
// can swap them back) and recreates the container from the new
// `:latest` — Docker binds a container to an image ID at creation, so
// re-tagging alone would never change what runs.

import { HttpError } from "@rodrigo-barraza/utilities-library/service";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { DeviceEntry } from "../../types.ts";
import { DockerClient, type DockerResponse } from "../../wrappers/DockerClient.ts";
import logger from "../../utils/logger.ts";
import { tryParseDockerError } from "./ContainerActions.ts";

interface ImageInspect {
  Id: string;
  Created?: string;
  Size?: number;
  Config?: { Labels?: Record<string, string> | null };
}

interface ContainerInspect {
  Id: string;
  Config?: Record<string, unknown>;
  HostConfig?: Record<string, unknown>;
  NetworkSettings?: { Networks?: Record<string, Record<string, unknown>> };
}

export interface PreviousImageInfo {
  tag: string;
  created: string | null;
  size: number;
  gitSha: string | null;
  gitBranch: string | null;
  buildTime: string | null;
}

/** 502 carrying Docker's own message unless the response has one of `okStatuses`. */
function expectStatus(response: DockerResponse, okStatuses: number[], failure: string): void {
  if (okStatuses.includes(response.statusCode)) return;
  throw new HttpError(tryParseDockerError(response.body) || `${failure} (${response.statusCode})`, 502);
}

async function inspectImage(device: DeviceEntry, reference: string): Promise<ImageInspect | null> {
  const response = await DockerClient.dockerRequest(
    device,
    "GET",
    `/images/${encodeURIComponent(reference)}/json`,
    { timeout: 8_000 },
  );
  if (response.statusCode === 404) return null;
  expectStatus(response, [200], `Failed to inspect image ${reference}`);
  return JSON.parse(response.body) as ImageInspect;
}

async function tagImage(device: DeviceEntry, imageId: string, repository: string, tag: string): Promise<void> {
  const response = await DockerClient.dockerRequest(
    device,
    "POST",
    `/images/${encodeURIComponent(imageId)}/tag?repo=${encodeURIComponent(repository)}&tag=${encodeURIComponent(tag)}`,
  );
  expectStatus(response, [201], `Failed to tag ${repository}:${tag}`);
}

/** Best-effort Docker call used while undoing a failed step — logs, never throws. */
async function attempt(
  description: string,
  request: () => Promise<DockerResponse>,
  okStatuses: number[] = [200, 201, 204, 304],
): Promise<void> {
  try {
    const response = await request();
    if (!okStatuses.includes(response.statusCode)) {
      logger.error(`[Rollback] ${description} failed (${response.statusCode}): ${response.body.substring(0, 200)}`);
    }
  } catch (error: unknown) {
    logger.error(`[Rollback] ${description} failed: ${getErrorMessage(error)}`);
  }
}

/** The `:previous` image a rollback would switch to, or null when there is none. */
export async function getPreviousImage(device: DeviceEntry, imageName: string): Promise<PreviousImageInfo | null> {
  const tag = `${imageName}:previous`;
  const image = await inspectImage(device, tag);
  if (!image) return null;

  const labels = image.Config?.Labels || {};
  return {
    tag,
    created: image.Created || null,
    size: image.Size || 0,
    gitSha: labels["git.sha"] || null,
    gitBranch: labels["git.branch"] || null,
    buildTime: labels["build.time"] || null,
  };
}

/**
 * Stop, rename, and replace a container so it runs `imageTag`. On any
 * failure — including a thrown timeout — the replacement is removed and
 * the original container is renamed back and restarted.
 */
async function recreateContainerWithImage(
  device: DeviceEntry,
  containerName: string,
  imageTag: string,
): Promise<void> {
  let inspect: ContainerInspect;
  try {
    inspect = await DockerClient.dockerGetJson<ContainerInspect>(
      device,
      `/containers/${encodeURIComponent(containerName)}/json`,
    );
  } catch (error: unknown) {
    throw new HttpError(`Failed to inspect container: ${getErrorMessage(error)}`, 502);
  }

  const oldContainerId = inspect.Id;
  const holdingName = `${containerName}-rollback-old`;

  // Networks: keep only creation-time fields — runtime fields (assigned
  // IP, endpoint ID, MAC) belong to the old container.
  const endpointsConfig: Record<string, unknown> = {};
  for (const [networkName, endpoint] of Object.entries(inspect.NetworkSettings?.Networks || {})) {
    endpointsConfig[networkName] = {
      Aliases: endpoint.Aliases || undefined,
      Links: endpoint.Links || undefined,
      IPAMConfig: endpoint.IPAMConfig || undefined,
    };
  }

  const createPayload = {
    ...(inspect.Config || {}),
    Image: imageTag,
    HostConfig: inspect.HostConfig || {},
    NetworkingConfig: { EndpointsConfig: endpointsConfig },
  };

  const restartOriginal = () =>
    attempt("Restart original container", () =>
      DockerClient.dockerRequest(device, "POST", `/containers/${oldContainerId}/start`),
    );

  // Stop the old container (304 = already stopped) and move it aside. A
  // stop that errors may still have landed — bring the service back.
  try {
    expectStatus(
      await DockerClient.dockerRequest(device, "POST", `/containers/${oldContainerId}/stop?t=10`),
      [204, 304],
      "Failed to stop container",
    );
  } catch (error: unknown) {
    await restartOriginal();
    throw error instanceof HttpError ? error : new HttpError(getErrorMessage(error), 502);
  }

  const renameResult = await DockerClient.dockerRequest(
    device,
    "POST",
    `/containers/${oldContainerId}/rename?name=${encodeURIComponent(holdingName)}`,
  ).catch((error: unknown) => {
    // The rename may or may not have landed — restart under whatever
    // name it holds, then surface the failure.
    return { statusCode: 0, body: JSON.stringify({ message: getErrorMessage(error) }) };
  });
  if (renameResult.statusCode !== 204) {
    await restartOriginal();
    expectStatus(renameResult, [204], "Failed to rename old container");
  }

  let newContainerId: string | null = null;
  // True while a create call is out with no answer — a timeout there may
  // still have produced a container.
  let createOutcomeUnknown = false;
  try {
    createOutcomeUnknown = true;
    const createResult = await DockerClient.dockerRequest(
      device,
      "POST",
      `/containers/create?name=${encodeURIComponent(containerName)}`,
      { body: createPayload },
    );
    createOutcomeUnknown = false;
    expectStatus(createResult, [201], "Failed to create replacement container");
    newContainerId = String((JSON.parse(createResult.body) as { Id?: unknown }).Id || "") || null;
    if (!newContainerId) throw new HttpError("Docker created the replacement without an ID", 502);

    expectStatus(
      await DockerClient.dockerRequest(device, "POST", `/containers/${newContainerId}/start`),
      [204, 304],
      "Failed to start replacement container",
    );
  } catch (error: unknown) {
    // The original answers to the holding name now, so after a create
    // that timed out, a container called containerName is ours.
    const replacementRef = newContainerId ?? (createOutcomeUnknown ? encodeURIComponent(containerName) : null);
    if (replacementRef) {
      await attempt(
        "Remove failed replacement",
        () => DockerClient.dockerRequest(device, "DELETE", `/containers/${replacementRef}?force=true`),
        [204, 404],
      );
    }
    await attempt("Restore original container name", () =>
      DockerClient.dockerRequest(
        device,
        "POST",
        `/containers/${oldContainerId}/rename?name=${encodeURIComponent(containerName)}`,
      ),
    );
    await restartOriginal();
    throw error instanceof HttpError ? error : new HttpError(getErrorMessage(error), 502);
  }

  // Success — the old container is disposable now
  await attempt("Remove replaced container", () =>
    DockerClient.dockerRequest(device, "DELETE", `/containers/${oldContainerId}?force=true`),
  );
}

/**
 * Swap `:latest` ↔ `:previous` and recreate the container from the new
 * `:latest`. The swap leaves `:previous` pointing at the image that was
 * running, so a second rollback rolls forward. If the recreate fails the
 * tags are swapped back, so they keep describing what actually runs.
 */
export async function rollbackToPreviousImage(
  device: DeviceEntry,
  imageName: string,
  containerName: string,
): Promise<void> {
  const previousImage = await inspectImage(device, `${imageName}:previous`);
  if (!previousImage) {
    throw new HttpError("No previous image available for rollback", 400);
  }
  const latestImage = await inspectImage(device, `${imageName}:latest`);

  await tagImage(device, previousImage.Id, imageName, "latest");
  if (latestImage) {
    await tagImage(device, latestImage.Id, imageName, "previous").catch((error: unknown) => {
      logger.warn(`[Rollback] Could not keep the current image as :previous for roll-forward: ${getErrorMessage(error)}`);
    });
  }

  logger.info(`[Rollback] Recreating ${containerName} from ${imageName}:latest`);
  try {
    await recreateContainerWithImage(device, containerName, `${imageName}:latest`);
  } catch (error: unknown) {
    if (latestImage) {
      await tagImage(device, latestImage.Id, imageName, "latest").catch((restoreError: unknown) => {
        logger.error(`[Rollback] Failed to restore :latest: ${getErrorMessage(restoreError)}`);
      });
    }
    await tagImage(device, previousImage.Id, imageName, "previous").catch((restoreError: unknown) => {
      logger.error(`[Rollback] Failed to restore :previous: ${getErrorMessage(restoreError)}`);
    });
    throw error;
  }
}
