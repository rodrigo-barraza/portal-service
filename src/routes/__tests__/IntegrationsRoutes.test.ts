import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { groupByCategory, integrationStatuses, keyFingerprint } from "../IntegrationsRoutes.ts";

const SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789";

describe("keyFingerprint", () => {
  it("is the first 8 hex chars of the SHA-256", () => {
    expect(keyFingerprint(SECRET)).toBe(createHash("sha256").update(SECRET).digest("hex").slice(0, 8));
    expect(keyFingerprint(SECRET)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("tells different keys apart and is null when unset", () => {
    expect(keyFingerprint(SECRET)).not.toBe(keyFingerprint(`${SECRET}x`));
    expect(keyFingerprint(undefined)).toBeNull();
    expect(keyFingerprint("")).toBeNull();
  });
});

describe("integrationStatuses", () => {
  it("never echoes any part of a configured key", () => {
    const statuses = integrationStatuses({ OPENAI_API_KEY: SECRET });
    const openai = statuses.find((status) => status.envKey === "OPENAI_API_KEY");

    expect(openai?.configured).toBe(true);
    expect(openai?.fingerprint).toBe(keyFingerprint(SECRET));
    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain(SECRET.slice(0, 4));
    expect(serialized).not.toContain(SECRET.slice(-4));
    expect(serialized).not.toContain("maskedKey");
  });

  it("groups by category with configured/total counts", () => {
    const categories = groupByCategory(integrationStatuses({ OPENAI_API_KEY: SECRET }));
    const ai = categories.find((category) => category.category === "AI / LLM");
    expect(ai?.configuredCount).toBe(1);
    expect(ai?.totalCount).toBe(ai?.integrations.length);
  });
});
