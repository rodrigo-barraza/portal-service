import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { GITHUB_PAT } from "../config.ts";
import logger from "../utils/logger.ts";

export interface GitHubRepoDetails {
  size: number;
  [key: string]: unknown;
}

export interface GitHubContentDetails {
  content?: string;
  size?: number;
  [key: string]: unknown;
}

export interface GitHubFetchStats {
  requests: number;
  failures: number;
  unauthorized: number;
  rateLimited: number;
  notFound: number;
}

export class GitHubClient {
  private static readonly GITHUB_API_BASE_URL = "https://api.github.com";
  private static readonly DEFAULT_TIMEOUT_MILLISECONDS = 8000;

  // Rolling counters since the last resetStats() — lets callers (e.g. the
  // code-analysis pipeline) distinguish "no edges found" from "GitHub was
  // unreachable / unauthorized" and surface that to the UI.
  private static stats: GitHubFetchStats = GitHubClient.emptyStats();

  private static emptyStats(): GitHubFetchStats {
    return { requests: 0, failures: 0, unauthorized: 0, rateLimited: 0, notFound: 0 };
  }

  public static resetStats(): void {
    this.stats = this.emptyStats();
  }

  public static getStats(): GitHubFetchStats {
    return { ...this.stats };
  }

  public static async fetchJson<T>(
    requestPath: string,
    timeoutMilliseconds: number = this.DEFAULT_TIMEOUT_MILLISECONDS
  ): Promise<T | null> {
    const abortController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      abortController.abort();
    }, timeoutMilliseconds);

    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "portal-service",
      };

      if (GITHUB_PAT) {
        headers.Authorization = `Bearer ${GITHUB_PAT}`;
      }

      this.stats.requests++;
      const response = await fetch(`${this.GITHUB_API_BASE_URL}${requestPath}`, {
        headers,
        signal: abortController.signal,
      });

      clearTimeout(timeoutTimer);

      if (!response.ok) {
        this.stats.failures++;
        if (response.status === 401) this.stats.unauthorized++;
        if (response.status === 404) this.stats.notFound++;
        if (response.status === 403) {
          const remaining = response.headers.get("x-ratelimit-remaining");
          if (remaining === "0") this.stats.rateLimited++;
          else this.stats.unauthorized++;
          if (!GITHUB_PAT) {
            logger.warn(
              `[GitHubClient] Rate limit or forbidden on ${requestPath}. Set GITHUB_PAT for access.`
            );
          }
        }
        return null;
      }

      return (await response.json()) as T;
    } catch (error: unknown) {
      clearTimeout(timeoutTimer);
      this.stats.failures++;
      const errorMessage = getErrorMessage(error);
      logger.warn(`[GitHubClient] Request to ${requestPath} failed: ${errorMessage}`);
      return null;
    }
  }

  public static async fetchFile(repoSlug: string, filePath: string): Promise<string | null> {
    const fileDetails = await this.fetchJson<GitHubContentDetails>(
      `/repos/${repoSlug}/contents/${filePath}`
    );

    if (!fileDetails || !fileDetails.content) {
      return null;
    }

    return Buffer.from(fileDetails.content, "base64").toString("utf-8");
  }

  public static async fetchRepoSize(repoSlug: string): Promise<{ sizeKB: number; sizeBytes: number } | null> {
    const repositoryDetails = await this.fetchJson<GitHubRepoDetails>(`/repos/${repoSlug}`);

    if (!repositoryDetails || typeof repositoryDetails.size !== "number") {
      return null;
    }

    return {
      sizeKB: repositoryDetails.size,
      sizeBytes: repositoryDetails.size * 1024,
    };
  }

  public static async fetchRepoLanguages(repoSlug: string): Promise<Record<string, number> | null> {
    return this.fetchJson<Record<string, number>>(`/repos/${repoSlug}/languages`);
  }
}
