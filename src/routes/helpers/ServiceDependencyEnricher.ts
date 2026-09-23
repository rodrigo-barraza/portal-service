import type { DependencyRef, EnrichedDependency } from "../../types.ts";

/** Anything that can sit in the dependency graph (a service or an infra store). */
export interface DependencyNode {
  id: string;
  name: string;
  dependsOn?: Array<string | DependencyRef>;
}

export type EnrichedNode<Node extends DependencyNode> = Omit<Node, "dependsOn"> & {
  dependsOn: EnrichedDependency[];
  dependedOnBy: EnrichedDependency[];
};

const DEFAULT_CRITICALITY = "required";

function dependencyId(dependency: string | DependencyRef): string {
  return typeof dependency === "string" ? dependency : dependency.id;
}

function dependencyCriticality(dependency: string | DependencyRef): string {
  return typeof dependency === "string" ? DEFAULT_CRITICALITY : dependency.criticality || DEFAULT_CRITICALITY;
}

export class ServiceDependencyEnricher {
  /**
   * Resolve every `dependsOn` edge to `{ id, name, criticality, source? }`
   * and add the inverse `dependedOnBy` list. Returns new objects — the
   * inputs are the registry services' shared status cache and must not
   * be mutated per request.
   */
  public static enrich<Service extends DependencyNode, Infrastructure extends DependencyNode>(
    services: Service[],
    infrastructure: Infrastructure[],
  ): { services: EnrichedNode<Service>[]; infrastructure: EnrichedNode<Infrastructure>[] } {
    const allNodes: DependencyNode[] = [...services, ...infrastructure];
    const nameById = new Map(allNodes.map((node) => [node.id, node.name]));

    const dependedOnBy = new Map<string, EnrichedDependency[]>();
    for (const node of allNodes) {
      for (const dependency of node.dependsOn || []) {
        const targetId = dependencyId(dependency);
        const inverse = dependedOnBy.get(targetId) ?? [];
        inverse.push({ id: node.id, name: node.name, criticality: dependencyCriticality(dependency) });
        dependedOnBy.set(targetId, inverse);
      }
    }

    const enrichNode = <Node extends DependencyNode>(node: Node): EnrichedNode<Node> => ({
      ...node,
      dependsOn: (node.dependsOn || []).map((dependency) => {
        const targetId = dependencyId(dependency);
        return {
          id: targetId,
          name: nameById.get(targetId) || targetId,
          criticality: dependencyCriticality(dependency),
          ...(typeof dependency === "object" && dependency.source ? { source: dependency.source } : {}),
        };
      }),
      dependedOnBy: dependedOnBy.get(node.id) ?? [],
    });

    return {
      services: services.map(enrichNode),
      infrastructure: infrastructure.map(enrichNode),
    };
  }
}
