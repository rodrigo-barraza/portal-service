// ─── ExternalProviderUsageService mapping tests ─────────────────────
// Pure helpers: host → provider metadata resolution, multi-host
// collapse for time-series lookups, and identifier validation for the
// merged /external-apis routes.

import { describe, it, expect } from "vitest";
import ExternalProviderUsageService, {
  __internal,
} from "../ExternalProviderUsageService.ts";

const { prettifyHostname, resolveHostProvider, hostsForProviderKey } = __internal;

describe("prettifyHostname", () => {
  it("strips prefixes and TLD noise", () => {
    expect(prettifyHostname("api.open-meteo.com")).toBe("Open Meteo");
    expect(prettifyHostname("www.eia.gov")).toBe("Eia");
    expect(prettifyHostname("hacker-news.firebaseio.com")).toBe("Hacker News Firebaseio");
  });
});

describe("resolveHostProvider", () => {
  it("maps known hosts to friendly providers", () => {
    expect(resolveHostProvider("api.ebay.com")).toMatchObject({
      key: "api.ebay.com",
      displayName: "eBay API",
      category: "Commerce",
    });
  });

  it("collapses sibling hosts onto one provider key", () => {
    expect(resolveHostProvider("accounts.spotify.com").key).toBe("api.spotify.com");
    expect(resolveHostProvider("oauth.reddit.com").key).toBe("reddit.com");
  });

  it("falls back to a prettified hostname card for unknown hosts", () => {
    const provider = resolveHostProvider("api.some-new-thing.io");
    expect(provider.key).toBe("api.some-new-thing.io");
    expect(provider.displayName).toBe("Some New Thing");
    expect(provider.category).toBe("Other");
    expect(provider.documentationUrl).toBe("https://api.some-new-thing.io");
  });
});

describe("hostsForProviderKey", () => {
  it("returns every host that rolls up into a provider", () => {
    expect(hostsForProviderKey("api.spotify.com").sort()).toEqual([
      "accounts.spotify.com",
      "api.spotify.com",
    ]);
  });

  it("returns the identifier itself for unmapped hosts", () => {
    expect(hostsForProviderKey("api.some-new-thing.io")).toEqual(["api.some-new-thing.io"]);
  });
});

describe("identifier validation", () => {
  it("accepts hostnames and llm-prefixed providers, rejects injection shapes", () => {
    expect(ExternalProviderUsageService.isValidServiceIdentifier("places.googleapis.com")).toBe(true);
    expect(ExternalProviderUsageService.isValidServiceIdentifier("llm:openai")).toBe(true);
    expect(ExternalProviderUsageService.isValidServiceIdentifier("api.ebay.com")).toBe(true);
    expect(ExternalProviderUsageService.isValidServiceIdentifier('bad"filter')).toBe(false);
    expect(ExternalProviderUsageService.isValidServiceIdentifier("")).toBe(false);
    expect(ExternalProviderUsageService.isLlmIdentifier("llm:moonshot")).toBe(true);
    expect(ExternalProviderUsageService.isLlmIdentifier("api.ebay.com")).toBe(false);
  });
});
