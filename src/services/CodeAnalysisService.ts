import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { PROJECTS } from "../config.ts";
import logger from "../utils/logger.ts";
import { GitHubClient } from "../wrappers/GitHubClient.ts";
import { EcosystemResolver, type EcosystemOwners } from "./code-analysis/EcosystemResolver.ts";

const CACHE_TTL_MILLISECONDS = 15 * 60 * 1000;
const CONFIG_PATHS = ["config.ts", "src/config.ts", "config.js", "src/config.js"];

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

let analysisCache: AnalysisResult | null = null;
let analysisCacheTimestamp = 0;

export default class CodeAnalysisService {
  public static async analyze(forceRefresh = false): Promise<AnalysisResult> {
    const currentTimestamp = Date.now();
    if (!forceRefresh && analysisCache && currentTimestamp - analysisCacheTimestamp < CACHE_TTL_MILLISECONDS) {
      return analysisCache;
    }

    logger.info("[CodeAnalysis] Starting ecosystem analysis...");
    const startTimestamp = Date.now();

    const ecosystemOwners = EcosystemResolver.deriveEcosystemOwners();
    logger.info(
      `[CodeAnalysis] Detected ${ecosystemOwners.owners.size} owner(s): ${[...ecosystemOwners.owners].join(", ") || "(none)"}`
    );

    const projectIds = new Set(Object.keys(PROJECTS));
    const dependencies: Record<string, ProjectAnalysis> = {};
    const repoSizes: Record<string, { sizeKB: number; sizeBytes: number }> = {};

    const projectsWithRepos = Object.entries(PROJECTS).filter(([, service]) => service.repo);

    await Promise.allSettled(
      projectsWithRepos.map(async ([projectId, service]) => {
        if (!service.repo) return;
        const repoSlug = CodeAnalysisService.extractSlug(service.repo);
        if (!repoSlug) return;

        try {
          const [imports, apiCalls, sizeDetails] = await Promise.all([
            CodeAnalysisService._detectImports(repoSlug, projectId, projectIds, ecosystemOwners),
            CodeAnalysisService._detectApiCalls(repoSlug, projectId, projectIds),
            GitHubClient.fetchRepoSize(repoSlug),
          ]);

          dependencies[projectId] = { imports, apiCalls };
          if (sizeDetails) {
            repoSizes[projectId] = sizeDetails;
          }
        } catch (error: unknown) {
          const errorMessage = getErrorMessage(error);
          logger.warn(`[CodeAnalysis] Failed for ${projectId}: ${errorMessage}`);
          dependencies[projectId] = { imports: [], apiCalls: [] };
        }
      })
    );

    const projectOwnerMapping: Record<string, string> = Object.fromEntries(
      ecosystemOwners.projectOwners
    );

    const analysisResult: AnalysisResult = {
      dependencies,
      repoSizes,
      owners: projectOwnerMapping,
      analyzedAt: new Date().toISOString(),
    };

    analysisCache = analysisResult;
    analysisCacheTimestamp = currentTimestamp;

    const totalImports = Object.values(dependencies).reduce((sum, projectDependency) => sum + projectDependency.imports.length, 0);
    const totalApiCalls = Object.values(dependencies).reduce(
      (sum, projectDependency) => sum + projectDependency.apiCalls.length,
      0
    );
    logger.info(
      `[CodeAnalysis] Done in ${Date.now() - startTimestamp}ms — ${totalImports} imports, ${totalApiCalls} API calls, ${Object.keys(repoSizes).length} sizes`
    );

    return analysisResult;
  }

  public static extractSlug(repoUrl: string): string | null {
    const matchedSlug = repoUrl.match(/github\.com\/(.+?)(?:\.git)?$/);
    return matchedSlug ? matchedSlug[1] : null;
  }

  private static async _detectImports(
    repoSlug: string,
    selfId: string,
    projectIds: Set<string>,
    ecosystemOwners: EcosystemOwners
  ): Promise<ImportEdge[]> {
    const packageJsonContent = await GitHubClient.fetchFile(repoSlug, "package.json");
    if (!packageJsonContent) return [];

    try {
      const packageJsonParsed = JSON.parse(packageJsonContent);
      const allDependencies: Record<string, string> = {
        ...packageJsonParsed.dependencies,
        ...packageJsonParsed.devDependencies,
      };
      const detectedImports: ImportEdge[] = [];

      for (const [name, version] of Object.entries(allDependencies)) {
        const targetId = EcosystemResolver.resolveEcosystemId(name, version, ecosystemOwners);
        if (targetId && targetId !== selfId && projectIds.has(targetId)) {
          detectedImports.push({ target: targetId, package: name });
        }
      }

      return detectedImports;
    } catch {
      return [];
    }
  }

  private static async _detectApiCalls(
    repoSlug: string,
    selfId: string,
    projectIds: Set<string>
  ): Promise<ApiCallEdge[]> {
    let configurationFileContent: string | null = null;
    for (const configPath of CONFIG_PATHS) {
      configurationFileContent = await GitHubClient.fetchFile(repoSlug, configPath);
      if (configurationFileContent) break;
    }
    if (!configurationFileContent) return [];

    const apiEnvVarRegex = /(?:NEXT_PUBLIC_)?([A-Z][A-Z0-9_]*?)_SERVICE_(?:URL|PUBLIC_URL)\b/g;
    const seenEnvironmentVariables = new Set<string>();
    const detectedApiCalls: ApiCallEdge[] = [];

    let regexMatch;
    while ((regexMatch = apiEnvVarRegex.exec(configurationFileContent)) !== null) {
      const fullEnvironmentVariable = regexMatch[0].replace(/^NEXT_PUBLIC_/, "");
      if (seenEnvironmentVariables.has(fullEnvironmentVariable)) continue;
      seenEnvironmentVariables.add(fullEnvironmentVariable);

      const servicePrefix = regexMatch[1].replace(/^NEXT_PUBLIC_/, "");
      const targetServiceId = servicePrefix.toLowerCase().replace(/_/g, "-") + "-service";

      if (targetServiceId !== selfId && projectIds.has(targetServiceId)) {
        detectedApiCalls.push({ target: targetServiceId, envVar: fullEnvironmentVariable });
      }
    }

    return detectedApiCalls;
  }
}
