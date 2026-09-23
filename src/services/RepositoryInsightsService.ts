// ─── Repository Insights ────────────────────────────────────
// Per-repository GitHub metadata (size, Linguist languages) for every
// registry project with a repo. Cached per repository, so the Projects
// page (/services/sizes, /services/languages) and the topology code
// analysis (/services/analysis) share requests — without a GITHUB_PAT
// the whole fleet has 60 GitHub calls an hour.

import { PROJECTS } from "../config.ts";
import { createDedupedTtlCache } from "../utils/cache.ts";
import { GitHubClient } from "../wrappers/GitHubClient.ts";

const REPO_SIZE_TTL_MS = 5 * 60_000;
const LANGUAGES_TTL_MS = 15 * 60_000;

export interface RepoSize {
  sizeKB: number;
  sizeBytes: number;
}

export interface LanguageBreakdown {
  primary: string | null;
  breakdown: Array<{ language: string; bytes: number; percent: number }>;
  totalBytes: number;
}

const repositoryCache = createDedupedTtlCache();

/** "https://github.com/owner/repo(.git)" → "owner/repo". */
export function extractRepoSlug(repoUrl: string): string | null {
  const matchedSlug = repoUrl.match(/github\.com\/(.+?)(?:\.git)?\/?$/);
  return matchedSlug ? matchedSlug[1] : null;
}

/** Linguist byte counts → sorted breakdown with one-decimal percentages. */
export function toLanguageBreakdown(languageBytes: Record<string, number>): LanguageBreakdown {
  const totalBytes = Object.values(languageBytes).reduce((sum, bytes) => sum + bytes, 0);
  const sorted = Object.entries(languageBytes).sort(([, firstBytes], [, secondBytes]) => secondBytes - firstBytes);

  return {
    primary: sorted[0]?.[0] ?? null,
    breakdown: sorted.map(([language, bytes]) => ({
      language,
      bytes,
      percent: totalBytes > 0 ? Math.round((bytes / totalBytes) * 1000) / 10 : 0,
    })),
    totalBytes,
  };
}

/** [projectId, repoSlug] for every registry project with a GitHub repo. */
function projectRepositories(): Array<[string, string]> {
  const repositories: Array<[string, string]> = [];
  for (const [projectId, project] of Object.entries(PROJECTS)) {
    const slug = project.repo ? extractRepoSlug(project.repo) : null;
    if (slug) repositories.push([projectId, slug]);
  }
  return repositories;
}

/** Fan a per-repo lookup out over every project, keeping the non-null answers. */
async function collectByProject<T>(lookup: (slug: string) => Promise<T | null>): Promise<Record<string, T>> {
  const byProject: Record<string, T> = {};
  await Promise.all(
    projectRepositories().map(async ([projectId, slug]) => {
      const value = await lookup(slug);
      if (value !== null) byProject[projectId] = value;
    }),
  );
  return byProject;
}

export default class RepositoryInsightsService {
  public static getRepoSize(slug: string): Promise<RepoSize | null> {
    return repositoryCache.get(`size:${slug}`, REPO_SIZE_TTL_MS, () => GitHubClient.fetchRepoSize(slug));
  }

  public static getLanguages(slug: string): Promise<LanguageBreakdown | null> {
    return repositoryCache.get(`languages:${slug}`, LANGUAGES_TTL_MS, async () => {
      const languageBytes = await GitHubClient.fetchRepoLanguages(slug);
      return languageBytes ? toLanguageBreakdown(languageBytes) : null;
    });
  }

  public static async getAllRepoSizes(): Promise<{ sizes: Record<string, RepoSize>; fetchedAt: string }> {
    const sizes = await collectByProject((slug) => RepositoryInsightsService.getRepoSize(slug));
    return { sizes, fetchedAt: new Date().toISOString() };
  }

  public static async getAllLanguages(): Promise<{ languages: Record<string, LanguageBreakdown>; fetchedAt: string }> {
    const languages = await collectByProject((slug) => RepositoryInsightsService.getLanguages(slug));
    return { languages, fetchedAt: new Date().toISOString() };
  }
}
