// ─── Google Service Account ─────────────────────────────────
// GOOGLE_ANALYTICS_CREDENTIALS holds a base64-encoded service-account
// key file; it authenticates both the GA4 Data API and Cloud Monitoring.

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  project_id: string;
}

export function parseServiceAccountCredentials(
  encoded: string | undefined,
): ServiceAccountCredentials {
  if (!encoded) {
    throw new Error("GOOGLE_ANALYTICS_CREDENTIALS is not set");
  }

  let parsed: Partial<ServiceAccountCredentials>;
  try {
    parsed = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf-8"),
    ) as Partial<ServiceAccountCredentials>;
  } catch (error: unknown) {
    throw new Error("GOOGLE_ANALYTICS_CREDENTIALS is not base64-encoded JSON", {
      cause: error,
    });
  }

  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    throw new Error(
      "GOOGLE_ANALYTICS_CREDENTIALS is missing client_email, private_key or project_id",
    );
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    project_id: parsed.project_id,
  };
}
