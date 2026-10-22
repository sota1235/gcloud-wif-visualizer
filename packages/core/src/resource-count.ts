import type { AccessTarget, FullResourceName, Snapshot } from './types.ts';

/** 実効アクセスが到達できるリソースの数（重複を除く）。assetTypeFilter で数えるアセットタイプを絞れる */
export type ResourceCounter = (targets: Iterable<AccessTarget>, assetTypeFilter?: (assetType: string) => boolean) => number;

/**
 * インベントリを読まずに、スナップショットの件数の表からリソース数を求める。
 * 互いに祖先・子孫の関係にない container の配下は重ならないため、祖先が対象に含まれる container を除いて件数を足し合わせる。
 */
export function createResourceCounter(snapshot: Pick<Snapshot, 'nodes' | 'resourceCounts' | 'targetResources'>): ResourceCounter {
  const parents = new Map<FullResourceName, FullResourceName | undefined>();
  for (const node of snapshot.nodes) {
    if (node.kind === 'container') parents.set(node.id, node.container.parent);
  }
  const strictAncestors = (container: FullResourceName): FullResourceName[] => {
    const result: FullResourceName[] = [];
    const visited = new Set([container]);
    for (let current = parents.get(container); current && !visited.has(current); current = parents.get(current)) {
      result.push(current);
      visited.add(current);
    }
    return result;
  };

  return (targets, assetTypeFilter = () => true) => {
    const containersByType = new Map<string, Set<FullResourceName>>();
    const resources = new Map<FullResourceName, string>();
    for (const target of targets) {
      if (target.grantedOnKind === 'container') {
        for (const type of target.assetTypes.filter(assetTypeFilter)) {
          const set = containersByType.get(type) ?? new Set();
          set.add(target.grantedOn);
          containersByType.set(type, set);
        }
      } else {
        const type = target.assetTypes[0] ?? '';
        if (assetTypeFilter(type)) resources.set(target.grantedOn, type);
      }
    }

    let total = 0;
    for (const [type, containers] of containersByType) {
      for (const container of containers) {
        if (strictAncestors(container).some((a) => containers.has(a))) continue;
        total += snapshot.resourceCounts[container]?.[type] ?? 0;
      }
    }
    for (const [name, type] of resources) {
      const containers = containersByType.get(type);
      const covered = containers && snapshot.targetResources[name]?.ancestors.some((a) => containers.has(a));
      if (!covered) total++;
    }
    return total;
  };
}
