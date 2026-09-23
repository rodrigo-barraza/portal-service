import { describe, it, expect } from "vitest";
import { parseServiceAccountCredentials } from "../googleCredentials.ts";

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64");

describe("parseServiceAccountCredentials", () => {
  it("decodes a base64 key file", () => {
    const credentials = {
      client_email: "reader@x.iam.gserviceaccount.com",
      private_key: "-----KEY-----",
      project_id: "x",
    };
    expect(
      parseServiceAccountCredentials(
        encode({ ...credentials, type: "service_account" }),
      ),
    ).toEqual(credentials);
  });

  it("fails with a message that names the variable, never its content", () => {
    expect(() => parseServiceAccountCredentials(undefined)).toThrow(
      "GOOGLE_ANALYTICS_CREDENTIALS is not set",
    );
    expect(() => parseServiceAccountCredentials("not-json")).toThrow(
      "not base64-encoded JSON",
    );
    expect(() =>
      parseServiceAccountCredentials(encode({ client_email: "a" })),
    ).toThrow("missing");
  });
});
