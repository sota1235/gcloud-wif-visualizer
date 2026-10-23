import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeEffectiveAccess } from '../src/effective.ts';
import { explore } from '../src/explore.ts';
import { buildAccessGraph } from '../src/graph.ts';
import { ResourceInventory } from '../src/inventory.ts';
import { readSnapshotFile, writeSnapshotFile } from '../src/node/snapshot-file.ts';
import { createSnapshot, parseSnapshot, snapshotToGraph } from '../src/snapshot.ts';
import { createStaticSource } from '../src/source.ts';
import { containers, inventoryResource, PROJECT_A, REPO_PRINCIPAL, roles, saMember, saResource, source } from './fixtures.ts';

const BUCKET = 'storage.googleapis.com/Bucket';
const DIRECT_BUCKET = '//storage.googleapis.com/direct';

async function snapshot() {
  const explored = await explore(
    [REPO_PRINCIPAL],
    createStaticSource(
      source([
        { resource: saResource('deploy'), role: 'roles/iam.workloadIdentityUser', member: REPO_PRINCIPAL },
        { resource: PROJECT_A, role: 'roles/viewer', member: saMember('deploy') },
        { resource: DIRECT_BUCKET, role: 'roles/storage.admin', member: saMember('deploy') },
      ]),
    ),
    { maxDepth: 5 },
  );
  const graph = buildAccessGraph({ pools: [], providers: [], containers, explored });
  const inventory = new ResourceInventory(containers, [
    inventoryResource('//storage.googleapis.com/a', BUCKET),
    inventoryResource(DIRECT_BUCKET, BUCKET, 'b'),
  ]);
  return {
    inventory,
    snapshot: createSnapshot({
      org: { id: '1' },
      collectedAt: new Date('2026-10-19T00:00:00Z'),
      options: { maxDepth: 5 },
      roles,
      graph,
      effectiveAccess: computeEffectiveAccess(graph, { rolePermissions: roles, assetTypeOf: (name) => inventory.get(name)?.assetType }),
      inventory,
    }),
  };
}

describe('snapshot', () => {
  it('JSON を経由しても内容が変わらない', async () => {
    const { snapshot: original } = await snapshot();
    const restored = parseSnapshot(JSON.stringify(original));

    expect(restored).toEqual(original);
    expect(snapshotToGraph(restored).nodes.size).toBe(original.nodes.length);
  });

  it('ノードとエッジを ID 順に並べる', async () => {
    const { snapshot: { nodes, edges } } = await snapshot();

    expect(nodes.map((n) => n.id)).toEqual(nodes.map((n) => n.id).sort((a, b) => a.localeCompare(b)));
    expect(edges.map((e) => e.id)).toEqual(edges.map((e) => e.id).sort((a, b) => a.localeCompare(b)));
  });

  it('件数の表と、リソースへの付与の付与先の祖先を持つ', async () => {
    const { snapshot: s } = await snapshot();

    expect(s.resourceCounts[PROJECT_A]).toEqual({ [BUCKET]: 1 });
    expect(Object.keys(s.targetResources)).toEqual([DIRECT_BUCKET]);
  });

  it('schemaVersion が異なるスナップショットは読み込まない', () => {
    expect(() => parseSnapshot(JSON.stringify({ schemaVersion: 1 }))).toThrow(/schemaVersion/);
  });
});

describe('スナップショットファイル', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wif-viz-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('書き出したファイルを読み込むと、スナップショットとインベントリが元に戻る', async () => {
    const { snapshot: original, inventory } = await snapshot();
    const path = join(dir, 'test.snapshot.jsonl.gz');
    await writeSnapshotFile(path, original, inventory);
    const restored = await readSnapshotFile(path);

    expect(restored.snapshot).toEqual(original);
    expect([...restored.inventory]).toEqual([...inventory]);
    expect(restored.inventory.list(PROJECT_A, BUCKET)).toEqual(['//storage.googleapis.com/a']);
  });

  it('inventory: false の場合はインベントリを読まない', async () => {
    const { snapshot: original, inventory } = await snapshot();
    const path = join(dir, 'test.snapshot.jsonl.gz');
    await writeSnapshotFile(path, original, inventory);
    const restored = await readSnapshotFile(path, { inventory: false });

    expect(restored.snapshot).toEqual(original);
    expect(restored.inventory.size).toBe(0);
  });

  it('gzip でないファイルは、旧形式の可能性を伝えるエラーにする', async () => {
    const path = join(dir, 'old.snapshot.json');
    await writeFile(path, JSON.stringify({ schemaVersion: 1 }));

    await expect(readSnapshotFile(path)).rejects.toThrow(/schemaVersion 1 以前/);
  });

  it('1 行目がスナップショットでないファイルはエラーにする', async () => {
    const path = join(dir, 'broken.snapshot.jsonl.gz');
    await writeFile(path, gzipSync(`${JSON.stringify({ type: 'resource', name: 'x' })}\n`));

    await expect(readSnapshotFile(path)).rejects.toThrow(/1 行目/);
  });
});
