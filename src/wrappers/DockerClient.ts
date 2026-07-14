import http from "http";
import type { DeviceEntry, DockerActionResponse, DockerTransport } from "../types.ts";

export class DockerClient {
  public static parseTransport(dockerApiUrl: string, requestPath: string): DockerTransport {
    if (dockerApiUrl.startsWith("unix://")) {
      return { socketPath: dockerApiUrl.slice(7), path: requestPath };
    }

    if (dockerApiUrl.startsWith("tcp://")) {
      const parsedUrl = new URL(dockerApiUrl.replace("tcp://", "http://"));
      return {
        hostname: parsedUrl.hostname,
        port: parseInt(parsedUrl.port, 10) || 2375,
        path: requestPath,
      };
    }

    throw new Error(`Unsupported Docker API protocol: ${dockerApiUrl}`);
  }

  public static dockerRequest(
    deviceEntry: DeviceEntry,
    httpMethod: string,
    requestPath: string,
    options: { timeout?: number; body?: unknown } = {}
  ): Promise<DockerActionResponse> {
    const timeoutMilliseconds = options.timeout ?? 30000;
    const requestBody =
      options.body === undefined ? null : JSON.stringify(options.body);

    return new Promise<DockerActionResponse>((resolve, reject) => {
      if (!deviceEntry.dockerApi) {
        return reject(new Error("No Docker API endpoint configured for this device"));
      }

      const transportOptions = this.parseTransport(deviceEntry.dockerApi, requestPath);

      const clientRequest = http.request(
        {
          ...transportOptions,
          method: httpMethod,
          headers: {
            "Content-Type": "application/json",
            ...(requestBody !== null
              ? { "Content-Length": Buffer.byteLength(requestBody) }
              : {}),
          },
        },
        (clientResponse: http.IncomingMessage) => {
          let responseBody = "";
          clientResponse.on("data", (chunk: Buffer) => {
            responseBody += chunk;
          });
          clientResponse.on("end", () => {
            resolve({
              statusCode: clientResponse.statusCode ?? 0,
              body: responseBody,
            });
          });
        }
      );

      clientRequest.setTimeout(timeoutMilliseconds, () => {
        clientRequest.destroy(new Error(`Docker API timeout after ${timeoutMilliseconds}ms`));
      });

      clientRequest.on("error", reject);
      if (requestBody !== null) clientRequest.write(requestBody);
      clientRequest.end();
    });
  }

  public static dockerGet(
    deviceEntry: DeviceEntry,
    requestPath: string,
    timeoutMilliseconds: number = 8000
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!deviceEntry.dockerApi) {
        return reject(new Error("No Docker API endpoint configured for this device"));
      }

      const transportOptions = this.parseTransport(deviceEntry.dockerApi, requestPath);

      const clientRequest = http.request(
        {
          ...transportOptions,
          method: "GET",
          headers: { Accept: "application/json" },
        },
        (clientResponse: http.IncomingMessage) => {
          let responseBody = "";
          clientResponse.on("data", (chunk: Buffer) => {
            responseBody += chunk;
          });
          clientResponse.on("end", () => {
            if (
              clientResponse.statusCode &&
              clientResponse.statusCode >= 200 &&
              clientResponse.statusCode < 300
            ) {
              resolve(responseBody);
            } else {
              reject(
                new Error(
                  `Docker API GET returned status ${clientResponse.statusCode}: ${responseBody.substring(0, 200)}`
                )
              );
            }
          });
        }
      );

      clientRequest.setTimeout(timeoutMilliseconds, () => {
        clientRequest.destroy(new Error(`Docker API timeout after ${timeoutMilliseconds}ms`));
      });

      clientRequest.on("error", reject);
      clientRequest.end();
    });
  }

  public static streamLogs(
    deviceEntry: DeviceEntry,
    containerName: string,
    queryParameters: Record<string, string>,
    isTty: boolean,
    onData: (chunk: Buffer, streamType: number) => void,
    onEnd: () => void,
    onError: (error: Error) => void
  ): http.ClientRequest {
    if (!deviceEntry.dockerApi) {
      throw new Error("No Docker API endpoint configured for this device");
    }

    const searchParameters = new URLSearchParams(queryParameters);
    const requestPath = `/containers/${containerName}/logs?${searchParameters.toString()}`;
    const transportOptions = this.parseTransport(deviceEntry.dockerApi, requestPath);

    const clientRequest = http.request(
      {
        ...transportOptions,
        method: "GET",
      },
      (clientResponse: http.IncomingMessage) => {
        if (clientResponse.statusCode !== 200) {
          let errorResponseBody = "";
          clientResponse.on("data", (chunk: Buffer) => {
            errorResponseBody += chunk;
          });
          clientResponse.on("end", () => {
            try {
              const parsedError = JSON.parse(errorResponseBody);
              onError(new Error(parsedError.message || `Docker API error: ${clientResponse.statusCode}`));
            } catch {
              onError(new Error(`Docker API error: ${clientResponse.statusCode}`));
            }
            onEnd();
          });
          return;
        }

        // TTY containers stream raw bytes with no mux framing — parsing the
        // 8-byte headers there reads garbage frame sizes and buffers forever.
        if (isTty) {
          clientResponse.on("data", (chunk: Buffer) => {
            onData(chunk, 1); // everything is stdout on a TTY
          });
          clientResponse.on("end", onEnd);
          clientResponse.on("error", onError);
          return;
        }

        let dataBuffer = Buffer.alloc(0);

        clientResponse.on("data", (chunk: Buffer) => {
          dataBuffer = Buffer.concat([dataBuffer, chunk]);

          while (dataBuffer.length >= 8) {
            const streamType = dataBuffer.readUInt8(0);
            const frameSize = dataBuffer.readUInt32BE(4);
            const totalFrameSize = 8 + frameSize;

            if (dataBuffer.length < totalFrameSize) {
              break; // Frame is incomplete, wait for more data
            }

            const framePayload = dataBuffer.subarray(8, totalFrameSize);
            dataBuffer = dataBuffer.subarray(totalFrameSize);

            onData(framePayload, streamType);
          }
        });

        clientResponse.on("end", onEnd);
        clientResponse.on("error", onError);
      }
    );

    clientRequest.on("error", onError);
    clientRequest.end();

    return clientRequest;
  }
}
