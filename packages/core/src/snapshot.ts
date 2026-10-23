import type { ResourceInventory } from './inventory.ts';
import { SNAPSHOT_SCHEMA_VERSION, type AccessGraph, type EffectiveAccess, type Snapshot, type TargetResource } from './types.ts';

export interface CreateSnapshotInput {
  org: Snapshot['org'];
  collectedAt: Date;
  options: Snapshot['options'];
  roles: Snapshot['roles'];
  graph: AccessGraph;
  effectiveAccess: EffectiveAccess[];
  /** 件数の表と、リソースへの付与の付与先の祖先を求めるのに使う（インベントリ自体はスナップショットに含めない） */
  inventory: ResourceInventory;
}

/** 差分を取りやすいよう、ノードとエッジを ID 順に並べて出力する */
export function createSnapshot(input: CreateSnapshotInput): Snapshot {
  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  const targetResources: Record<string, TargetResource> = {};
  for (const name of [...new Set(input.effectiveAccess.filter((r) => r.grantedOnKind === 'resource').map((r) => r.grantedOn))].sort()) {
    const target = input.inventory.targetResource(name);
    if (target) targetResources[name] = target;
  }
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    collectedAt: input.collectedAt.toISOString(),
    org: input.org,
    options: input.options,
    roles: Object.fromEntries(Object.entries(input.roles).sort(([a], [b]) => a.localeCompare(b))),
    nodes: [...input.graph.nodes.values()].sort(byId),
    edges: [...input.graph.edges.values()].sort(byId),
    effectiveAccess: [...input.effectiveAccess].sort(byId),
    resourceCounts: input.inventory.resourceCounts(),
    targetResources,
  };
}

export function parseSnapshot(json: string): Snapshot {
  const data = JSON.parse(json) as Partial<Snapshot>;
  if (data.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`unsupported snapshot schemaVersion: ${String(data.schemaVersion)} (expected ${SNAPSHOT_SCHEMA_VERSION})`);
  }
  return data as Snapshot;
}

export function snapshotToGraph(snapshot: Snapshot): AccessGraph {
  return {
    nodes: new Map(snapshot.nodes.map((n) => [n.id, n])),
    edges: new Map(snapshot.edges.map((e) => [e.id, e])),
  };
}
