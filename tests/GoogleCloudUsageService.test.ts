import { describe, expect, it } from "vitest";
import GoogleCloudUsageService, {
  __internal,
} from "../src/services/GoogleCloudUsageService.ts";

const { KNOWN_API_METADATA, EXCLUDED_INFRASTRUCTURE_SERVICES, prettifyServiceIdentifier, resolveApiMetadata } =
  __internal;

describe("GoogleCloudUsageService metadata", () => {
  it("uses the full Cloud Monitoring labels for Maps Platform backends", () => {
    // Monitoring reports "geocoding-backend.googleapis.com", not
    // "geocoding-backend" — the bare names silently matched nothing.
    expect(KNOWN_API_METADATA["geocoding-backend.googleapis.com"]).toBeDefined();
    expect(KNOWN_API_METADATA["static-maps-backend.googleapis.com"]).toBeDefined();
    expect(KNOWN_API_METADATA["geocoding-backend"]).toBeUndefined();
    expect(KNOWN_API_METADATA["static-maps-backend"]).toBeUndefined();
  });

  it("tracks the Gemini API", () => {
    expect(KNOWN_API_METADATA["generativelanguage.googleapis.com"]?.displayName).toBe("Gemini API");
  });

  it("resolves known services to their curated metadata", () => {
    const metadata = resolveApiMetadata("pollen.googleapis.com");
    expect(metadata.displayName).toBe("Pollen API");
    expect(metadata.category).toBe("Environmental");
    expect(metadata.consumer).toBe("tools-service");
  });

  it("derives a readable fallback for unknown services instead of hiding them", () => {
    const metadata = resolveApiMetadata("timezone-backend.googleapis.com");
    expect(metadata.displayName).toBe("Timezone Backend");
    expect(metadata.category).toBe("Other");
    expect(metadata.documentationUrl).toContain("timezone-backend.googleapis.com");
  });

  it("never excludes a service that also has curated metadata", () => {
    for (const serviceIdentifier of Object.keys(KNOWN_API_METADATA)) {
      expect(EXCLUDED_INFRASTRUCTURE_SERVICES.has(serviceIdentifier)).toBe(false);
    }
  });
});

describe("GoogleCloudUsageService.isValidServiceIdentifier", () => {
  it("accepts real service identifiers", () => {
    expect(GoogleCloudUsageService.isValidServiceIdentifier("places.googleapis.com")).toBe(true);
    expect(GoogleCloudUsageService.isValidServiceIdentifier("geocoding-backend.googleapis.com")).toBe(true);
  });

  it("rejects monitoring-filter injection attempts", () => {
    expect(GoogleCloudUsageService.isValidServiceIdentifier("")).toBe(false);
    expect(GoogleCloudUsageService.isValidServiceIdentifier('x" OR metric.type = "')).toBe(false);
    expect(GoogleCloudUsageService.isValidServiceIdentifier("UPPER.googleapis.com")).toBe(false);
  });
});

describe("prettifyServiceIdentifier", () => {
  it("strips the googleapis suffix and title-cases the rest", () => {
    expect(prettifyServiceIdentifier("generativelanguage.googleapis.com")).toBe("Generativelanguage");
    expect(prettifyServiceIdentifier("static-maps-backend.googleapis.com")).toBe("Static Maps Backend");
  });
});
