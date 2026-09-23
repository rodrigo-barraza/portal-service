// ─── Deduped TTL Cache ──────────────────────────────────────
// utilities-library's createTtlCache invokes the fetcher once per
// concurrent miss (it has no in-flight dedupe by design). Every portal
// cache fronts an expensive upstream (Docker /system/df, GitHub, GA,
// Cloud Monitoring), so concurrent callers for one key share one fetch.

import { createTtlCache, type TtlCacheOptions } from "@rodrigo-barraza/utilities-library/cache";

export interface DedupedTtlCache {
  get<T>(key: string, ttlMilliseconds: number, fetcher: () => Promise<T>): Promise<T>;
  /** Store a value fetched elsewhere (e.g. by a background poller) as fresh. */
  set(key: string, data: unknown): void;
  delete(key: string): void;
  clear(): void;
}

export function createDedupedTtlCache(options?: TtlCacheOptions): DedupedTtlCache {
  const cache = createTtlCache(options);
  const inflight = new Map<string, Promise<unknown>>();

  return {
    get<T>(key: string, ttlMilliseconds: number, fetcher: () => Promise<T>): Promise<T> {
      const pending = inflight.get(key);
      if (pending) return pending as Promise<T>;

      const request = cache.get(key, ttlMilliseconds, fetcher).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, request);
      return request;
    },
    set(key: string, data: unknown): void {
      cache.set(key, data);
    },
    delete(key: string): void {
      cache.delete(key);
    },
    clear(): void {
      cache.clear();
    },
  };
}
