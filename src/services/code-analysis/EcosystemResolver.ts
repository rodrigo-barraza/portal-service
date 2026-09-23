import { escapeRegex } from "@rodrigo-barraza/utilities-library";
import { PROJECTS } from "../../config.ts";
import logger from "../../utils/logger.ts";

export interface EcosystemOwners {
  owners: Set<string>;
  scopePrefixes: Set<string>;
  projectOwners: Map<string, string>;
}

export class EcosystemResolver {
  public static deriveEcosystemOwners(): EcosystemOwners {
    const owners = new Set<string>();
    const scopePrefixes = new Set<string>();
    const projectOwners = new Map<string, string>();

    for (const [projectId, projectEntry] of Object.entries(PROJECTS)) {
      if (!projectEntry.repo) continue;
      const repositoryMatch = projectEntry.repo.match(/github\.com\/([^/]+)\//);
      if (repositoryMatch) {
        const repositoryOwner = repositoryMatch[1];
        owners.add(repositoryOwner);
        scopePrefixes.add(`@${repositoryOwner}/`);
        projectOwners.set(projectId, repositoryOwner);
      }
    }

    if (owners.size === 0) {
      logger.warn(
        "[EcosystemResolver] No GitHub repository URLs found in registry — analysis will be limited"
      );
    }

    return { owners, scopePrefixes, projectOwners };
  }

  public static resolveEcosystemId(
    packageName: string,
    packageVersion: string,
    ecosystemOwners: EcosystemOwners
  ): string | null {
    for (const prefix of ecosystemOwners.scopePrefixes) {
      if (packageName.startsWith(prefix)) {
        return packageName.slice(prefix.length);
      }
    }

    // github:owner/repo, https://github.com/owner/repo.git,
    // git+ssh://git@github.com:owner/repo — each optionally pinned "#ref".
    for (const owner of ecosystemOwners.owners) {
      const gitHubMatch = packageVersion.match(
        new RegExp(`(?:^github:|github\\.com[/:])${escapeRegex(owner)}/([^/#]+?)(?:\\.git)?(?:#.*)?$`),
      );
      if (gitHubMatch) {
        return gitHubMatch[1];
      }
    }

    const localFileLinkMatch = packageVersion.match(/^file:\.\.\/(.+?)$/);
    if (localFileLinkMatch) {
      return localFileLinkMatch[1];
    }

    return null;
  }
}
