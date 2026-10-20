import { computeEffectiveAccess } from '../src/effective.ts';
import { explore } from '../src/explore.ts';
import { buildAccessGraph } from '../src/graph.ts';
import { isWifMember } from '../src/names.ts';
import { createSnapshot } from '../src/snapshot.ts';
import { createStaticSource } from '../src/source.ts';
import type { InventoryResource, MemberBinding, Snapshot, WorkloadIdentityPool, WorkloadIdentityPoolProvider } from '../src/types.ts';
import { GITHUB_ISSUER } from '../src/workload.ts';
import { containers, POOL, roles, source } from './fixtures.ts';

export const pool = (overrides: Partial<WorkloadIdentityPool> = {}): WorkloadIdentityPool => ({
  name: POOL,
  projectNumber: '111',
  poolId: 'github',
  disabled: false,
  ...overrides,
});

export const githubProvider = (overrides: Partial<WorkloadIdentityPoolProvider> = {}): WorkloadIdentityPoolProvider => ({
  name: `${POOL}/providers/github`,
  poolName: POOL,
  providerId: 'github',
  kind: 'oidc',
  issuerUri: GITHUB_ISSUER,
  attributeMapping: {
    'google.subject': 'assertion.sub',
    'attribute.repository': 'assertion.repository',
    'attribute.repository_id': 'assertion.repository_id',
    'attribute.actor': 'assertion.actor',
  },
  attributeCondition: "assertion.repository_owner_id == '1'",
  disabled: false,
  ...overrides,
});

export interface SnapshotInput {
  bindings: MemberBinding[];
  pools?: WorkloadIdentityPool[];
  providers?: WorkloadIdentityPoolProvider[];
  inventory?: InventoryResource[];
  existingServiceAccounts?: Set<string>;
  collectedAt?: string;
}

/** バインディングなどからスナップショットを組み立てる（principal はバインディングから自動で抽出する） */
export async function buildSnapshot(input: SnapshotInput): Promise<Snapshot> {
  const principals = [...new Set(input.bindings.map((b) => b.member).filter(isWifMember))];
  const explored = await explore(principals, createStaticSource(source(input.bindings)), { maxDepth: 5 });
  const graph = buildAccessGraph({
    pools: input.pools ?? [pool()],
    providers: input.providers ?? [githubProvider()],
    containers,
    explored,
    ...(input.existingServiceAccounts ? { existingServiceAccounts: input.existingServiceAccounts } : {}),
  });
  return createSnapshot({
    org: { id: '1' },
    collectedAt: new Date(input.collectedAt ?? '2026-10-19T00:00:00Z'),
    options: { maxDepth: 5 },
    roles,
    graph,
    effectiveAccess: computeEffectiveAccess(graph, { inventory: input.inventory ?? [], rolePermissions: roles }),
  });
}
