// ─── Docker Engine API Client ───────────────────────────────
// Minimal HTTP client over the Engine API — unix socket (local NAS) or
// tcp:// (remote hosts). Every request carries a timeout; a response
// that dies mid-body rejects instead of leaving the promise pending.

import http from "node:http";
import type { DeviceEntry } from "../types.ts";

export interface DockerResponse {
  statusCode: number;
  body: string;
}

interface DockerTransport {
  socketPath?: string;
  hostname?: string;
  port?: number;
  path: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_GET_TIMEOUT_MS = 8_000;
const DEFAULT_DOCKER_TCP_PORT = 2375;

/** Docker mux stream type for stdout (1) and stderr (2). */
const STDOUT_STREAM = 1;

export class DockerClient {
  public static parseTransport(dockerApiUrl: string, requestPath: string): DockerTransport {
    if (dockerApiUrl.startsWith("unix://")) {
      return { socketPath: dockerApiUrl.slice("unix://".length), path: requestPath };
    }

    if (dockerApiUrl.startsWith("tcp://")) {
      const parsedUrl = new URL(dockerApiUrl.replace("tcp://", "http://"));
      return {
        hostname: parsedUrl.hostname,
        port: Number.parseInt(parsedUrl.port, 10) || DEFAULT_DOCKER_TCP_PORT,
        path: requestPath,
      };
    }

    throw new Error(`Unsupported Docker API protocol: ${dockerApiUrl}`);
  }

  /**
   * One Engine API round trip. Resolves with the status and body for any
   * HTTP status — callers decide which codes mean success (204, 304…).
   */
  public static dockerRequest(
    deviceEntry: DeviceEntry,
    httpMethod: string,
    requestPath: string,
    options: { timeout?: number; body?: unknown } = {},
  ): Promise<DockerResponse> {
    const timeoutMilliseconds = options.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const requestBody = options.body === undefined ? null : JSON.stringify(options.body);

    return new Promise<DockerResponse>((resolve, reject) => {
      if (!deviceEntry.dockerApi) {
        reject(new Error("No Docker API endpoint configured for this device"));
        return;
      }

      const clientRequest = http.request(
        {
          ...DockerClient.parseTransport(deviceEntry.dockerApi, requestPath),
          method: httpMethod,
          headers: {
            Accept: "application/json",
            ...(requestBody !== null
              ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(requestBody) }
              : {}),
          },
        },
        (clientResponse: http.IncomingMessage) => {
          // Collect bytes and decode once — decoding per chunk corrupts a
          // multi-byte character split across chunk boundaries.
          const chunks: Buffer[] = [];
          clientResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
          clientResponse.on("end", () => {
            resolve({
              statusCode: clientResponse.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          // A socket reset mid-body errors the response, not the request.
          clientResponse.on("error", reject);
        },
      );

      clientRequest.setTimeout(timeoutMilliseconds, () => {
        clientRequest.destroy(new Error(`Docker API timeout after ${timeoutMilliseconds}ms`));
      });
      clientRequest.on("error", reject);
      if (requestBody !== null) clientRequest.write(requestBody);
      clientRequest.end();
    });
  }

  /** GET that resolves with the body of a 2xx response and rejects otherwise. */
  public static async dockerGet(
    deviceEntry: DeviceEntry,
    requestPath: string,
    timeoutMilliseconds: number = DEFAULT_GET_TIMEOUT_MS,
  ): Promise<string> {
    const response = await DockerClient.dockerRequest(deviceEntry, "GET", requestPath, {
      timeout: timeoutMilliseconds,
    });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Docker API GET returned status ${response.statusCode}: ${response.body.substring(0, 200)}`,
      );
    }
    return response.body;
  }

  /** dockerGet + JSON.parse. */
  public static async dockerGetJson<T>(
    deviceEntry: DeviceEntry,
    requestPath: string,
    timeoutMilliseconds?: number,
  ): Promise<T> {
    return JSON.parse(await DockerClient.dockerGet(deviceEntry, requestPath, timeoutMilliseconds)) as T;
  }

  /**
   * Open a container log stream. Non-TTY containers multiplex stdout and
   * stderr into 8-byte-header frames; TTY containers stream raw bytes.
   */
  public static streamLogs(
    deviceEntry: DeviceEntry,
    containerName: string,
    queryParameters: Record<string, string>,
    isTty: boolean,
    onData: (chunk: Buffer, streamType: number) => void,
    onEnd: () => void,
    onError: (error: Error) => void,
  ): http.ClientRequest {
    if (!deviceEntry.dockerApi) {
      throw new Error("No Docker API endpoint configured for this device");
    }

    const searchParameters = new URLSearchParams(queryParameters);
    const requestPath = `/containers/${encodeURIComponent(containerName)}/logs?${searchParameters.toString()}`;

    const clientRequest = http.request(
      {
        ...DockerClient.parseTransport(deviceEntry.dockerApi, requestPath),
        method: "GET",
      },
      (clientResponse: http.IncomingMessage) => {
        clientResponse.on("error", onError);

        if (clientResponse.statusCode !== 200) {
          const errorChunks: Buffer[] = [];
          clientResponse.on("data", (chunk: Buffer) => errorChunks.push(chunk));
          clientResponse.on("end", () => {
            let message = `Docker API error: ${clientResponse.statusCode}`;
            try {
              message = JSON.parse(Buffer.concat(errorChunks).toString("utf8")).message || message;
            } catch {
              // Non-JSON error body — keep the status-code message
            }
            onError(new Error(message));
            onEnd();
          });
          return;
        }

        // TTY containers stream raw bytes with no mux framing — parsing the
        // 8-byte headers there reads garbage frame sizes and buffers forever.
        if (isTty) {
          clientResponse.on("data", (chunk: Buffer) => onData(chunk, STDOUT_STREAM));
          clientResponse.on("end", onEnd);
          return;
        }

        let dataBuffer: Buffer = Buffer.alloc(0);

        clientResponse.on("data", (chunk: Buffer) => {
          dataBuffer = dataBuffer.length === 0 ? chunk : Buffer.concat([dataBuffer, chunk]);

          while (dataBuffer.length >= 8) {
            const streamType = dataBuffer.readUInt8(0);
            const frameSize = dataBuffer.readUInt32BE(4);
            const totalFrameSize = 8 + frameSize;

            if (dataBuffer.length < totalFrameSize) {
              break; // Frame is incomplete, wait for more data
            }

            onData(dataBuffer.subarray(8, totalFrameSize), streamType);
            dataBuffer = dataBuffer.subarray(totalFrameSize);
          }
        });

        clientResponse.on("end", onEnd);
      },
    );

    clientRequest.on("error", onError);
    clientRequest.end();

    return clientRequest;
  }
}
