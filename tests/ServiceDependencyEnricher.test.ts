import { describe, it, expect } from "vitest";
import { ServiceDependencyEnricher } from "../src/routes/helpers/ServiceDependencyEnricher.ts";

describe("ServiceDependencyEnricher", () => {
  it("should enrich service dependencies and inverse dependedOnBy mapping", () => {
    const servicesList = [
      {
        id: "web-client",
        name: "Web Client",
        dependsOn: ["api-service", { id: "database-service", criticality: "required" }],
      },
      {
        id: "api-service",
        name: "API Service",
        dependsOn: [{ id: "database-service", criticality: "essential" }],
      },
    ];

    const infrastructureList = [
      {
        id: "database-service",
        name: "Database Service",
      },
    ];

    const result = ServiceDependencyEnricher.enrich(servicesList, infrastructureList);

    // Assert web-client dependencies mapped correctly
    expect(result.services[0].dependsOn).toEqual([
      { id: "api-service", name: "API Service", criticality: "required" },
      { id: "database-service", name: "Database Service", criticality: "required" },
    ]);

    // Assert api-service dependencies mapped correctly
    expect(result.services[1].dependsOn).toEqual([
      { id: "database-service", name: "Database Service", criticality: "essential" },
    ]);

    // Assert dependedOnBy mapping on database-service is constructed
    expect(result.infrastructure[0].dependedOnBy).toEqual([
      { id: "web-client", name: "Web Client", criticality: "required" },
      { id: "api-service", name: "API Service", criticality: "essential" },
    ]);

    // Assert dependedOnBy mapping on api-service is constructed
    expect(result.services[1].dependedOnBy).toEqual([
      { id: "web-client", name: "Web Client", criticality: "required" },
    ]);
  });

  it("should handle empty dependencies list gracefully", () => {
    const servicesList = [
      { id: "lone-service", name: "Lone Service" },
    ];
    const infrastructureList = [] as Record<string, unknown>[];

    const result = ServiceDependencyEnricher.enrich(servicesList, infrastructureList);

    expect(result.services[0].dependsOn).toEqual([]);
    expect(result.services[0].dependedOnBy).toEqual([]);
  });
});
