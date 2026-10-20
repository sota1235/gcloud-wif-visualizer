import { lint, type Finding } from './lint.ts';
import { snapshotToGraph } from './snapshot.ts';
import type { EffectiveAccess, GraphNode, ProviderNode, Snapshot, WorkloadIdentityPool, WorkloadIdentityPoolProvider } from './types.ts';
import type { InferOptions } from './workload.ts';

export interface AccessChange {
  before: EffectiveAccess;
  after: EffectiveAccess;
  addedResources: string[];
  removedResources: string[];
  /** conditional が変わったか */
  conditionalChanged: boolean;
}

export interface ConfigChange<T> {
  id: string;
  before: T;
  after: T;
  /** 変更されたフィールド名 */
  fields: string[];
}

export interface SnapshotDiff {
  base: { collectedAt: string };
  head: { collectedAt: string };
  access: { added: EffectiveAccess[]; removed: EffectiveAccess[]; changed: AccessChange[] };
  providers: {
    added: WorkloadIdentityPoolProvider[];
    removed: WorkloadIdentityPoolProvider[];
    changed: ConfigChange<WorkloadIdentityPoolProvider>[];
  };
  pools: { added: WorkloadIdentityPool[]; removed: WorkloadIdentityPool[]; changed: ConfigChange<WorkloadIdentityPool>[] };
  findings: { added: Finding[]; resolved: Finding[] };
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function changedFields<T extends object>(before: T, after: T): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => JSON.stringify(before[key as keyof T]) !== JSON.stringify(after[key as keyof T]))
    .sort();
}

function diffById<T>(base: Map<string, T>, head: Map<string, T>) {
  const added = [...head].filter(([id]) => !base.has(id)).map(([, v]) => v);
  const removed = [...base].filter(([id]) => !head.has(id)).map(([, v]) => v);
  const both = [...head].filter(([id]) => base.has(id)).map(([id, after]) => ({ id, before: base.get(id)!, after }));
  return { added, removed, both };
}

function configNodes<K extends GraphNode['kind']>(snapshot: Snapshot, kind: K) {
  return snapshot.nodes.filter((n): n is Extract<GraphNode, { kind: K }> => n.kind === kind);
}

function diffConfig<T extends object>(base: Map<string, T>, head: Map<string, T>) {
  const { added, removed, both } = diffById(base, head);
  const changed = both
    .map(({ id, before, after }) => ({ id, before, after, fields: changedFields(before, after) }))
    .filter((c) => c.fields.length > 0);
  return { added, removed, changed };
}

export function findingsOf(snapshot: Snapshot, inferOptions?: InferOptions): Finding[] {
  return lint({ graph: snapshotToGraph(snapshot), effectiveAccess: snapshot.effectiveAccess, roles: snapshot.roles, ...(inferOptions ? { inferOptions } : {}) });
}

/** 2 つのスナップショットの差分。Lint はスナップショットから都度算出する（ルールの改善を過去のスナップショットにも反映するため） */
export function diffSnapshots(base: Snapshot, head: Snapshot, inferOptions?: InferOptions): SnapshotDiff {
  if (base.org.id !== head.org.id) throw new Error(`different organizations: ${base.org.id} and ${head.org.id}`);

  const access = diffById(byId(base.effectiveAccess), byId(head.effectiveAccess));
  const changed: AccessChange[] = access.both
    .map(({ before, after }) => {
      const beforeNames = new Set(before.resources.map((r) => r.name));
      const afterNames = new Set(after.resources.map((r) => r.name));
      return {
        before,
        after,
        addedResources: [...afterNames].filter((n) => !beforeNames.has(n)).sort(),
        removedResources: [...beforeNames].filter((n) => !afterNames.has(n)).sort(),
        conditionalChanged: before.conditional !== after.conditional,
      };
    })
    .filter((c) => c.addedResources.length > 0 || c.removedResources.length > 0 || c.conditionalChanged);

  const providerMap = (s: Snapshot) => new Map(configNodes(s, 'provider').map((n: ProviderNode) => [n.id, n.provider]));
  const poolMap = (s: Snapshot) => new Map(configNodes(s, 'pool').map((n) => [n.id, n.pool]));
  const findings = diffById(byId(findingsOf(base, inferOptions)), byId(findingsOf(head, inferOptions)));

  return {
    base: { collectedAt: base.collectedAt },
    head: { collectedAt: head.collectedAt },
    access: { added: access.added, removed: access.removed, changed },
    providers: diffConfig(providerMap(base), providerMap(head)),
    pools: diffConfig(poolMap(base), poolMap(head)),
    findings: { added: findings.added, resolved: findings.removed },
  };
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return (
    diff.access.added.length + diff.access.removed.length + diff.access.changed.length === 0 &&
    diff.providers.added.length + diff.providers.removed.length + diff.providers.changed.length === 0 &&
    diff.pools.added.length + diff.pools.removed.length + diff.pools.changed.length === 0 &&
    diff.findings.added.length + diff.findings.resolved.length === 0
  );
}
