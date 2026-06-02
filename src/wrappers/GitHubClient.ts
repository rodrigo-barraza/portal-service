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

export class GitHubClient {
  private static readonly GITHUB_API_BASE_URL = "https://api.github.com";
  private static readonly DEFAULT_TIMEOUT_MILLISECONDS = 8000;

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

      const response = await fetch(`${this.GITHUB_API_BASE_URL}${requestPath}`, {
        headers,
        signal: abortController.signal,
      });

      clearTimeout(timeoutTimer);

      if (!response.ok) {
        if (!GITHUB_PAT && response.status === 403) {
          logger.warn(
            `[GitHubClient] Rate limit or forbidden on ${requestPath}. Set GITHUB_PAT for access.`
          );
        }
        return null;
      }

      return (await response.json()) as T;
    } catch (error: unknown) {
      clearTimeout(timeoutTimer);
      const errorMessage = error instanceof Error ? error.message : String(error);
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
