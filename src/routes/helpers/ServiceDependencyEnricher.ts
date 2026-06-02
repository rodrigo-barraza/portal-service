import type { EnrichedDependency } from "../../types.ts";

export class ServiceDependencyEnricher {
  public static enrich(
    servicesList: Record<string, any>[],
    infrastructureList: Record<string, any>[]
  ): { services: Record<string, any>[]; infrastructure: Record<string, any>[] } {
    const combinedList = [...servicesList, ...infrastructureList] as Array<
      Record<string, any> & {
        id: string;
        name: string;
        dependsOn?: Array<string | { id: string; criticality?: string }>;
        dependedOnBy?: EnrichedDependency[];
      }
    >;

    const serviceNameMapping = Object.fromEntries(
      combinedList.map((serviceEntry) => [serviceEntry.id, serviceEntry.name])
    );

    const getDependencyId = (dependency: string | { id: string }) =>
      typeof dependency === "string" ? dependency : dependency.id;

    const getDependencyCriticality = (
      dependency: string | { id: string; criticality?: string }
    ) => (typeof dependency === "string" ? "required" : dependency.criticality || "required");

    const inverseDependenciesMap: Record<string, EnrichedDependency[]> = {};

    for (const serviceItem of combinedList) {
      for (const dependency of serviceItem.dependsOn || []) {
        const dependencyId = getDependencyId(dependency);
        if (!inverseDependenciesMap[dependencyId]) {
          inverseDependenciesMap[dependencyId] = [];
        }
        inverseDependenciesMap[dependencyId].push({
          id: serviceItem.id,
          name: serviceItem.name,
          criticality: getDependencyCriticality(dependency),
        });
      }
    }

    for (const serviceItem of combinedList) {
      serviceItem.dependsOn = (serviceItem.dependsOn || []).map((dependency) => {
        const dependencyId = getDependencyId(dependency);
        return {
          id: dependencyId,
          name: serviceNameMapping[dependencyId] || dependencyId,
          criticality: getDependencyCriticality(dependency),
        };
      });
      serviceItem.dependedOnBy = inverseDependenciesMap[serviceItem.id] || [];
    }

    return { services: servicesList, infrastructure: infrastructureList };
  }
}
