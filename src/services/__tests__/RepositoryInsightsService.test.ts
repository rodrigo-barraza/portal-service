import { describe, it, expect } from "vitest";
import { extractRepoSlug, toLanguageBreakdown } from "../RepositoryInsightsService.ts";

describe("extractRepoSlug", () => {
  it("reads owner/repo from GitHub URLs", () => {
    expect(extractRepoSlug("https://github.com/rodrigo-barraza/portal-service")).toBe("rodrigo-barraza/portal-service");
    expect(extractRepoSlug("https://github.com/rodrigo-barraza/portal-service.git")).toBe("rodrigo-barraza/portal-service");
    expect(extractRepoSlug("https://github.com/rodrigo-barraza/portal-service/")).toBe("rodrigo-barraza/portal-service");
  });

  it("returns null for non-GitHub URLs", () => {
    expect(extractRepoSlug("https://gitlab.com/x/y")).toBeNull();
  });
});

describe("toLanguageBreakdown", () => {
  it("sorts by bytes and rounds percentages to one decimal", () => {
    const breakdown = toLanguageBreakdown({ CSS: 100, TypeScript: 800, JavaScript: 100 });
    expect(breakdown.primary).toBe("TypeScript");
    expect(breakdown.totalBytes).toBe(1000);
    expect(breakdown.breakdown[0]).toEqual({ language: "TypeScript", bytes: 800, percent: 80 });
    expect(breakdown.breakdown.map((entry) => entry.language)).toEqual(["TypeScript", "CSS", "JavaScript"]);
  });

  it("handles a repo with no detected languages", () => {
    expect(toLanguageBreakdown({})).toEqual({ primary: null, breakdown: [], totalBytes: 0 });
  });
});
