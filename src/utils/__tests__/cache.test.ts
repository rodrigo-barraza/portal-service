import { describe, it, expect, vi } from "vitest";
import { createDedupedTtlCache } from "../cache.ts";

describe("createDedupedTtlCache", () => {
  it("shares one fetch between concurrent callers for a key", async () => {
    const cache = createDedupedTtlCache();
    let resolveFetch!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveFetch = resolve;
    });
    const fetcher = vi.fn(() => pending);

    const first = cache.get("k", 1_000, fetcher);
    const second = cache.get("k", 1_000, fetcher);
    resolveFetch("value");

    expect(await first).toBe("value");
    expect(await second).toBe("value");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves the cached value inside the TTL and refetches after a clear", async () => {
    const cache = createDedupedTtlCache();
    const fetcher = vi.fn(async () => Math.random());

    const first = await cache.get("k", 60_000, fetcher);
    expect(await cache.get("k", 60_000, fetcher)).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);

    cache.clear();
    await cache.get("k", 60_000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("lets a failed fetch be retried by the next caller", async () => {
    const cache = createDedupedTtlCache();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("up");

    await expect(cache.get("k", 60_000, fetcher)).rejects.toThrow("down");
    expect(await cache.get("k", 60_000, fetcher)).toBe("up");
  });
});
