import { describe, expect, it } from 'vitest';
import { computeEffectiveAccess } from '../src/effective.ts';
import { explore } from '../src/explore.ts';
import { buildAccessGraph } from '../src/graph.ts';
import { createSnapshot, parseSnapshot, snapshotToGraph } from '../src/snapshot.ts';
import { createStaticSource } from '../src/source.ts';
import { containers, PROJECT_A, REPO_PRINCIPAL, roles, saMember, saResource, source } from './fixtures.ts';

async function snapshot() {
  const explored = await explore(
    [REPO_PRINCIPAL],
    createStaticSource(
      source([
        { resource: saResource('deploy'), role: 'roles/iam.workloadIdentityUser', member: REPO_PRINCIPAL },
        { resource: PROJECT_A, role: 'roles/viewer', member: saMember('deploy') },
      ]),
    ),
    { maxDepth: 5 },
  );
  const graph = buildAccessGraph({ pools: [], providers: [], containers, explored });
  return createSnapshot({
    org: { id: '1' },
    collectedAt: new Date('2026-10-19T00:00:00Z'),
    options: { maxDepth: 5 },
    roles,
    graph,
    effectiveAccess: computeEffectiveAccess(graph, { inventory: [], rolePermissions: roles }),
  });
}

describe('snapshot', () => {
  it('JSON を経由しても内容が変わらない', async () => {
    const original = await snapshot();
    const restored = parseSnapshot(JSON.stringify(original));

    expect(restored).toEqual(original);
    expect(snapshotToGraph(restored).nodes.size).toBe(original.nodes.length);
  });

  it('ノードとエッジを ID 順に並べる', async () => {
    const { nodes, edges } = await snapshot();

    expect(nodes.map((n) => n.id)).toEqual(nodes.map((n) => n.id).sort((a, b) => a.localeCompare(b)));
    expect(edges.map((e) => e.id)).toEqual(edges.map((e) => e.id).sort((a, b) => a.localeCompare(b)));
  });

  it('schemaVersion が異なるスナップショットは読み込まない', () => {
    expect(() => parseSnapshot(JSON.stringify({ schemaVersion: 999 }))).toThrow(/schemaVersion/);
  });
});
