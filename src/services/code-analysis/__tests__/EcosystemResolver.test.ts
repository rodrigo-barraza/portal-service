import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EcosystemResolver } from "../EcosystemResolver.ts";
import { PROJECTS } from "../../../config.ts";

describe("EcosystemResolver", () => {
  let projectsBackup: Record<string, any>;

  beforeEach(() => {
    projectsBackup = { ...PROJECTS };
  });

  afterEach(() => {
    for (const key of Object.keys(PROJECTS)) {
      delete PROJECTS[key];
    }
    Object.assign(PROJECTS, projectsBackup);
  });

  describe("deriveEcosystemOwners", () => {
    it("should extract owners and scope prefixes from projects registry", () => {
      // Setup mock projects registry entries
      PROJECTS["prism-client"] = {
        name: "Prism Client",
        url: "https://prism.rod.dev",
        port: null,
        healthPath: "/",
        environment: "Production",
        visibility: "internal",
        projectType: "Client",
        description: null,
        db: null,
        minioBucket: null,
        repo: "https://github.com/rodrigo-barraza/prism-client",
        npmPackage: null,
        device: "synology",
        domain: null,
        dockerProject: null,
        deployTier: 1,
        essential: false,
        dependsOn: [],
      };

      PROJECTS["other-service"] = {
        name: "Other Service",
        url: "https://other.rod.dev",
        port: null,
        healthPath: "/",
        environment: "Production",
        visibility: "internal",
        projectType: "Service",
        description: null,
        db: null,
        minioBucket: null,
        repo: "https://github.com/someone-else/other-service.git",
        npmPackage: null,
        device: "synology",
        domain: null,
        dockerProject: null,
        deployTier: 1,
        essential: false,
        dependsOn: [],
      };

      const result = EcosystemResolver.deriveEcosystemOwners();

      expect(result.owners.has("rodrigo-barraza")).toBe(true);
      expect(result.owners.has("someone-else")).toBe(true);
      expect(result.scopePrefixes.has("@rodrigo-barraza/")).toBe(true);
      expect(result.scopePrefixes.has("@someone-else/")).toBe(true);
      expect(result.projectOwners.get("prism-client")).toBe("rodrigo-barraza");
      expect(result.projectOwners.get("other-service")).toBe("someone-else");
    });
  });

  describe("resolveEcosystemId", () => {
    const mockEcosystemOwners = {
      owners: new Set(["rodrigo-barraza"]),
      scopePrefixes: new Set(["@rodrigo-barraza/"]),
      projectOwners: new Map([["prism-client", "rodrigo-barraza"]]),
    };

    it("should resolve ecosystem ID from scoped package name", () => {
      const resolvedId = EcosystemResolver.resolveEcosystemId(
        "@rodrigo-barraza/utilities-library",
        "1.0.0",
        mockEcosystemOwners
      );
      expect(resolvedId).toBe("utilities-library");
    });

    it("should resolve ecosystem ID from short github version pattern", () => {
      const resolvedId = EcosystemResolver.resolveEcosystemId(
        "service-library",
        "github:rodrigo-barraza/service-library",
        mockEcosystemOwners
      );
      expect(resolvedId).toBe("service-library");
    });

    it("should resolve ecosystem ID from full github https version pattern", () => {
      const resolvedId = EcosystemResolver.resolveEcosystemId(
        "service-library",
        "https://github.com/rodrigo-barraza/service-library.git",
        mockEcosystemOwners
      );
      expect(resolvedId).toBe("service-library");
    });

    it("should resolve ecosystem ID from local file links", () => {
      const resolvedId = EcosystemResolver.resolveEcosystemId(
        "local-pkg",
        "file:../local-pkg",
        mockEcosystemOwners
      );
      expect(resolvedId).toBe("local-pkg");
    });

    it("should return null if package matches no resolver strategies", () => {
      const resolvedId = EcosystemResolver.resolveEcosystemId(
        "lodash",
        "^4.17.21",
        mockEcosystemOwners
      );
      expect(resolvedId).toBeNull();
    });
  });
});
