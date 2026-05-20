// ─── Code Analysis Service ──────────────────────────────────
// Auto-detects ecosystem dependencies by scanning project source
// files via GitHub API. Replaces hand-maintained dependsOn arrays
// with real detected relationships.
//
// Owner/scope are derived at runtime from the repo URLs already
// in the project registry — no hard-coded GitHub username needed.

import { PROJECTS, GITHUB_PAT } from "../config.ts";
import logger from "../utils/logger.ts";

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 8000;

const CONFIG_PATHS = ["config.ts", "src/config.ts", "config.js", "src/config.js"];

interface EcosystemOwners {
    owners: Set<string>;
  scopePrefixes: Set<string>;
    projectOwners: Map<string, string>;
}

function deriveEcosystemOwners(): EcosystemOwners {
  const owners = new Set<string>();
  const scopePrefixes = new Set<string>();
  const projectOwners = new Map<string, string>();

  for (const [id, svc] of Object.entries(PROJECTS)) {
    if (!svc.repo) continue;
    const match = svc.repo.match(/github\.com\/([^/]+)\//);
    if (match) {
      const owner = match[1];
      owners.add(owner);
      scopePrefixes.add(`@${owner}/`);
      projectOwners.set(id, owner);
    }
  }

  if (owners.size === 0) {
    logger.warn("[CodeAnalysis] No GitHub repo URLs found in registry — analysis will be limited");
  }

  return { owners, scopePrefixes, projectOwners };
}

// ── Types ───────────────────────────────────────────────────

interface ImportEdge {
  target: string;
  package: string;
}

interface ApiCallEdge {
  target: string;
  envVar: string;
}

interface ProjectAnalysis {
  imports: ImportEdge[];
  apiCalls: ApiCallEdge[];
}

interface AnalysisResult {
  dependencies: Record<string, ProjectAnalysis>;
  repoSizes: Record<string, { sizeKB: number; sizeBytes: number }>;
    owners: Record<string, string>;
  analyzedAt: string;
}

// ── Cache ───────────────────────────────────────────────────

let cache: AnalysisResult | null = null;
let cacheAt = 0;

// ── Service ─────────────────────────────────────────────────

export default class CodeAnalysisService {
    static async analyze(forceRefresh = false): Promise<AnalysisResult> {
    const now = Date.now();
    if (!forceRefresh && cache && now - cacheAt < CACHE_TTL_MS) {
      return cache;
    }

    logger.info("[CodeAnalysis] Starting ecosystem analysis...");
    const start = Date.now();

    const ecosystem = deriveEcosystemOwners();
    logger.info(`[CodeAnalysis] Detected ${ecosystem.owners.size} owner(s): ${[...ecosystem.owners].join(", ") || "(none)"}`);

    const projectIds = new Set(Object.keys(PROJECTS));
    const dependencies: Record<string, ProjectAnalysis> = {};
    const repoSizes: Record<string, { sizeKB: number; sizeBytes: number }> = {};

    const entries = Object.entries(PROJECTS).filter(([, svc]) => svc.repo);

    await Promise.allSettled(
      entries.map(async ([id, svc]) => {
        if (!svc.repo) return;
        const slug = CodeAnalysisService._extractSlug(svc.repo);
        if (!slug) return;

        try {
          const [imports, apiCalls, size] = await Promise.all([
            CodeAnalysisService._detectImports(slug, id, projectIds, ecosystem),
            CodeAnalysisService._detectApiCalls(slug, id, projectIds),
            CodeAnalysisService._fetchRepoSize(slug),
          ]);

          dependencies[id] = { imports, apiCalls };
          if (size) repoSizes[id] = size;
        } catch (err: unknown) {
          const e = err as Error;
          logger.warn(`[CodeAnalysis] Failed for ${id}: ${e.message}`);
          dependencies[id] = { imports: [], apiCalls: [] };
        }
      }),
    );

    // Build per-project owner map for the response
    const owners: Record<string, string> = Object.fromEntries(ecosystem.projectOwners);

    const result: AnalysisResult = { dependencies, repoSizes, owners, analyzedAt: new Date().toISOString() };
    cache = result;
    cacheAt = now;

    const totalImports = Object.values(dependencies).reduce((s, d) => s + d.imports.length, 0);
    const totalApi = Object.values(dependencies).reduce((s, d) => s + d.apiCalls.length, 0);
    logger.info(`[CodeAnalysis] Done in ${Date.now() - start}ms — ${totalImports} imports, ${totalApi} API calls, ${Object.keys(repoSizes).length} sizes`);

    return result;
  }

  // ── GitHub API Helpers ──────────────────────────────────────

  private static _extractSlug(repoUrl: string): string | null {
    const match = repoUrl.match(/github\.com\/(.+?)(?:\.git)?$/);
    return match ? match[1] : null;
  }

  private static async _githubGet(path: string): Promise<Record<string, any> | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "portal-service",
      };
      if (GITHUB_PAT) headers.Authorization = `Bearer ${GITHUB_PAT}`;

      const resp = await fetch(`${GITHUB_API}${path}`, { headers, signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) return null;
      return (await resp.json()) as Record<string, any>;
    } catch {
      clearTimeout(timeout);
      return null;
    }
  }

  private static async _fetchFile(slug: string, filePath: string): Promise<string | null> {
    const data = await CodeAnalysisService._githubGet(`/repos/${slug}/contents/${filePath}`);
    if (!data?.content) return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  }

  // ── Import Detection (package.json) ─────────────────────────

  private static async _detectImports(
    slug: string, selfId: string, projectIds: Set<string>,
    ecosystem: EcosystemOwners,
  ): Promise<ImportEdge[]> {
    const content = await CodeAnalysisService._fetchFile(slug, "package.json");
    if (!content) return [];

    try {
      const pkg = JSON.parse(content);
      const allDeps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
      const imports: ImportEdge[] = [];

      for (const [name, version] of Object.entries(allDeps)) {
        const targetId = CodeAnalysisService._resolveEcosystemId(name, version, ecosystem);
        if (targetId && targetId !== selfId && projectIds.has(targetId)) {
          imports.push({ target: targetId, package: name });
        }
      }

      return imports;
    } catch {
      return [];
    }
  }

    private static _resolveEcosystemId(
    name: string, version: string, ecosystem: EcosystemOwners,
  ): string | null {
    // Check scoped packages against all ecosystem owners
    for (const prefix of ecosystem.scopePrefixes) {
      if (name.startsWith(prefix)) {
        return name.slice(prefix.length);
      }
    }

    // Check GitHub URL patterns against all ecosystem owners
    for (const owner of ecosystem.owners) {
      const ghShort = version.match(new RegExp(`^github:${owner}/(.+?)$`));
      if (ghShort) return ghShort[1];

      const ghHttps = version.match(new RegExp(`github\\.com/${owner}/(.+?)(?:\\.git)?$`));
      if (ghHttps) return ghHttps[1];
    }

    const fileLink = version.match(/^file:\.\.\/(.+?)$/);
    if (fileLink) return fileLink[1];

    return null;
  }

  // ── API Call Detection (config files) ───────────────────────

  private static async _detectApiCalls(
    slug: string, selfId: string, projectIds: Set<string>,
  ): Promise<ApiCallEdge[]> {
    let content: string | null = null;
    for (const path of CONFIG_PATHS) {
      content = await CodeAnalysisService._fetchFile(slug, path);
      if (content) break;
    }
    if (!content) return [];

    // Match: PRISM_SERVICE_URL, TOOLS_SERVICE_PUBLIC_URL, NEXT_PUBLIC_*_SERVICE_URL
    const regex = /(?:NEXT_PUBLIC_)?([A-Z][A-Z0-9_]*?)_SERVICE_(?:URL|PUBLIC_URL)\b/g;
    const seen = new Set<string>();
    const apiCalls: ApiCallEdge[] = [];

    let match;
    while ((match = regex.exec(content)) !== null) {
      const fullVar = match[0].replace(/^NEXT_PUBLIC_/, "");
      if (seen.has(fullVar)) continue;
      seen.add(fullVar);

      const prefix = match[1].replace(/^NEXT_PUBLIC_/, "");
      // PRISM → prism-service, CLOCK_CREW → clock-crew-service
      const targetId = prefix.toLowerCase().replace(/_/g, "-") + "-service";

      if (targetId !== selfId && projectIds.has(targetId)) {
        apiCalls.push({ target: targetId, envVar: fullVar });
      }
    }

    return apiCalls;
  }

  // ── Repo Size (GitHub API) ─────────────────────────────────

  private static async _fetchRepoSize(
    slug: string,
  ): Promise<{ sizeKB: number; sizeBytes: number } | null> {
    const data = await CodeAnalysisService._githubGet(`/repos/${slug}`);
    if (!data?.size) return null;
    return { sizeKB: data.size, sizeBytes: data.size * 1024 };
  }
}
