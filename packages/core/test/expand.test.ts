import { describe, expect, it } from 'vitest';
import { EXPANDABLE_ASSET_TYPES, assetTypesForPermissions } from '../src/asset-types.ts';
import { computeEffectiveAccess } from '../src/effective.ts';
import { explore } from '../src/explore.ts';
import { buildAccessGraph } from '../src/graph.ts';
import { createStaticSource } from '../src/source.ts';
import type { InventoryResource, MemberBinding } from '../src/types.ts';
import { containers, FOLDER, ORG, PROJECT_A, PROJECT_B, REPO_PRINCIPAL, roles, source } from './fixtures.ts';

const bucket = (name: string, project: '111' | '222'): InventoryResource => ({
  name: `//storage.googleapis.com/${name}`,
  assetType: 'storage.googleapis.com/Bucket',
  project: `projects/${project}`,
  folders: project === '111' ? ['folders/10'] : [],
  organization: 'organizations/1',
});

const inventory: InventoryResource[] = [
  bucket('bucket-a', '111'),
  bucket('bucket-b', '222'),
  {
    name: '//secretmanager.googleapis.com/projects/111/secrets/token',
    assetType: 'secretmanager.googleapis.com/Secret',
    project: 'projects/111',
    folders: ['folders/10'],
    organization: 'organizations/1',
  },
];

async function access(bindings: Omit<MemberBinding, 'member'>[]) {
  const withMember = bindings.map((b) => ({ ...b, member: REPO_PRINCIPAL }));
  const explored = await explore([REPO_PRINCIPAL], createStaticSource(source(withMember)), { maxDepth: 5 });
  const graph = buildAccessGraph({ pools: [], providers: [], containers, explored });
  return computeEffectiveAccess(graph, { inventory, rolePermissions: roles });
}

const names = (rows: Awaited<ReturnType<typeof access>>) => rows.flatMap((r) => r.resources.map((x) => x.name));

describe('リソース展開', () => {
  it('project に付与されたロールを、配下の該当アセットタイプのリソースに展開する', async () => {
    const [row] = await access([{ resource: PROJECT_A, role: 'roles/storage.admin' }]);

    expect(row).toMatchObject({
      grantedOnKind: 'container',
      resources: [{ name: '//storage.googleapis.com/bucket-a', assetType: 'storage.googleapis.com/Bucket' }],
      unmappedPermissionCount: 0,
    });
  });

  it('folder / org に付与されたロールは子孫の project のリソースまで展開する', async () => {
    expect(names(await access([{ resource: FOLDER, role: 'roles/storage.admin' }]))).toEqual(['//storage.googleapis.com/bucket-a']);
    expect(names(await access([{ resource: ORG, role: 'roles/storage.admin' }]))).toEqual([
      '//storage.googleapis.com/bucket-a',
      '//storage.googleapis.com/bucket-b',
    ]);
  });

  it('対応表にない permission は数だけを記録する', async () => {
    const [viewer] = await access([{ resource: PROJECT_B, role: 'roles/viewer' }]);
    const [iamAdmin] = await access([{ resource: PROJECT_B, role: 'roles/resourcemanager.projectIamAdmin' }]);

    expect(viewer).toMatchObject({ resources: [{ name: '//storage.googleapis.com/bucket-b' }], unmappedPermissionCount: 1 });
    expect(iamAdmin).toMatchObject({ resources: [], unmappedPermissionCount: 2 });
  });

  it('個別のリソースへの付与はそのリソースだけを対象にし、アセットタイプを補う', async () => {
    const [row] = await access([{ resource: '//storage.googleapis.com/bucket-b', role: 'roles/storage.admin' }]);

    expect(row).toMatchObject({
      grantedOnKind: 'resource',
      resources: [{ name: '//storage.googleapis.com/bucket-b', assetType: 'storage.googleapis.com/Bucket' }],
    });
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

    expect(() => computeEffectiveAccess(graph, { inventory, rolePermissions: {} })).toThrow(/roles\/storage.admin/);
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
