// ─── ExternalProviderUsageService summary ───────────────────────────
// The tools-service source must not re-count Google APIs: Cloud Monitoring
// already reports every *.googleapis.com call, so a tools-service bucket for
// one of those hosts is the same traffic again (it showed as a second
// "Airquality Googleapis" card and doubled the dashboard total).

import { describe, it, expect, vi } from "vitest";

const TOOLS_BUCKETS = [
  {
    service: "tools-service",
    host: "airquality.googleapis.com",
    date: "2099-01-01",
    requests: 88,
    errors: 1,
  },
  {
    service: "tools-service",
    host: "places.googleapis.com",
    date: "2099-01-01",
    requests: 40,
    errors: 0,
  },
  {
    service: "tools-service",
    host: "api.spotify.com",
    date: "2099-01-01",
    requests: 12,
    errors: 2,
  },
  {
    service: "tools-service",
    host: "accounts.spotify.com",
    date: "2099-01-01",
    requests: 3,
    errors: 0,
  },
];

vi.mock("../../config.ts", () => ({
  PRISM_MONGO_DB_NAME: "prism",
  TOOLS_MONGO_DB_NAME: "tools",
}));

vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: (name: string) =>
      name === "tools"
        ? {
            collection: () => ({
              find: () => ({ toArray: async () => TOOLS_BUCKETS }),
            }),
          }
        : null,
  },
}));

const { default: ExternalProviderUsageService } =
  await import("../ExternalProviderUsageService.ts");

describe("ExternalProviderUsageService.getSummary", () => {
  it("leaves *.googleapis.com traffic to Cloud Monitoring and keeps every other host", async () => {
    const summary = await ExternalProviderUsageService.getSummary("30d");

    const identifiers = summary.services.map(
      (service) => service.serviceIdentifier,
    );
    expect(
      identifiers.some((identifier) => identifier.endsWith(".googleapis.com")),
    ).toBe(false);
    expect(summary.services).toHaveLength(1);
    expect(summary.services[0]).toMatchObject({
      serviceIdentifier: "api.spotify.com",
      totalRequests: 15,
      errorRequests: 2,
    });
    // The prism source is unavailable in this test; it degrades, the tools source still answers.
    expect(summary.unreachableSources).toEqual(["prism (prism)"]);
  });
});
