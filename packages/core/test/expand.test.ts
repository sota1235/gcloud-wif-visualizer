import { describe, expect, it } from 'vitest';
import { EXPANDABLE_ASSET_TYPES, assetTypesForPermissions } from '../src/asset-types.ts';
import { computeEffectiveAccess } from '../src/effective.ts';
import { explore } from '../src/explore.ts';
import { buildAccessGraph } from '../src/graph.ts';
import { createStaticSource } from '../src/source.ts';
import type { MemberBinding } from '../src/types.ts';
import { containers, PROJECT_A, PROJECT_B, REPO_PRINCIPAL, roles, source } from './fixtures.ts';

const BUCKET_B = '//storage.googleapis.com/bucket-b';

async function access(bindings: Omit<MemberBinding, 'member'>[]) {
  const withMember = bindings.map((b) => ({ ...b, member: REPO_PRINCIPAL }));
  const explored = await explore([REPO_PRINCIPAL], createStaticSource(source(withMember)), { maxDepth: 5 });
  const graph = buildAccessGraph({ pools: [], providers: [], containers, explored });
  const assetTypes: Record<string, string> = { [BUCKET_B]: 'storage.googleapis.com/Bucket' };
  return computeEffectiveAccess(graph, { rolePermissions: roles, assetTypeOf: (name) => assetTypes[name] });
}

describe('リソース展開', () => {
  it('container に付与されたロールは、対応表で判定したアセットタイプを持つ', async () => {
    const [row] = await access([{ resource: PROJECT_A, role: 'roles/storage.admin' }]);

    expect(row).toMatchObject({ grantedOnKind: 'container', assetTypes: ['storage.googleapis.com/Bucket'], unmappedPermissionCount: 0 });
  });

  it('対応表にない permission は数だけを記録する', async () => {
    const [viewer] = await access([{ resource: PROJECT_B, role: 'roles/viewer' }]);
    const [iamAdmin] = await access([{ resource: PROJECT_B, role: 'roles/resourcemanager.projectIamAdmin' }]);

    expect(viewer).toMatchObject({ assetTypes: ['storage.googleapis.com/Bucket'], unmappedPermissionCount: 1 });
    expect(iamAdmin).toMatchObject({ assetTypes: [], unmappedPermissionCount: 2 });
  });

  it('個別のリソースへの付与は、そのリソースのアセットタイプを持つ。インベントリにない場合は空にする', async () => {
    const [known] = await access([{ resource: BUCKET_B, role: 'roles/storage.admin' }]);
    const [unknown] = await access([{ resource: '//storage.googleapis.com/unknown', role: 'roles/storage.admin' }]);

    expect(known).toMatchObject({ grantedOnKind: 'resource', assetTypes: ['storage.googleapis.com/Bucket'] });
    expect(unknown).toMatchObject({ grantedOnKind: 'resource', assetTypes: [] });
  });

  it('条件だけが異なる同じ付与は 1 行にまとめ、条件なしがあれば無条件とする', async () => {
    const rows = await access([
      { resource: PROJECT_A, role: 'roles/storage.admin', condition: { expression: 'resource.name.startsWith("x")' } },
      { resource: PROJECT_A, role: 'roles/storage.admin' },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.conditional).toBe(false);
  });

  it('permission が不明なロールはエラーにする', async () => {
    const explored = await explore(
      [REPO_PRINCIPAL],
      createStaticSource(source([{ resource: PROJECT_A, role: 'roles/storage.admin', member: REPO_PRINCIPAL }])),
      { maxDepth: 5 },
    );
    const graph = buildAccessGraph({ pools: [], providers: [], containers, explored });

    expect(() => computeEffectiveAccess(graph, { rolePermissions: {} })).toThrow(/roles\/storage.admin/);
  });
});

describe('asset-types', () => {
  it('対応表のアセットタイプは Cloud Asset の形式で、検索できないタイプを含まない', () => {
    for (const type of EXPANDABLE_ASSET_TYPES) expect(type).toMatch(/^[a-z]+\.googleapis\.com\/[A-Z][A-Za-z]+$/);
    expect(EXPANDABLE_ASSET_TYPES).not.toContain('cloudscheduler.googleapis.com/Job');
  });

  it('permission をアセットタイプと対応表にないものに分ける', () => {
    expect(assetTypesForPermissions(['storage.objects.get', 'secretmanager.versions.access', 'logging.logEntries.list'])).toEqual({
      assetTypes: ['secretmanager.googleapis.com/Secret', 'storage.googleapis.com/Bucket'],
      unmappedPermissions: ['logging.logEntries.list'],
    });
  });
});
