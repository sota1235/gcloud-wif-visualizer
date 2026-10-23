import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectSnapshotFromExport, exportCommands, readAssetExport } from '../src/export.ts';
import type { GcpClient } from '../src/gcp.ts';

const CRM = '//cloudresourcemanager.googleapis.com/';
const POOL = 'projects/111/locations/global/workloadIdentityPools/github';
const PRINCIPAL = `principalSet://iam.googleapis.com/${POOL}/attribute.repository/org/app`;
const SA_EMAIL = 'deploy@proj.iam.gserviceaccount.com';
const SA = `serviceAccount:${SA_EMAIL}`;
const SA_NAME = `//iam.googleapis.com/projects/proj/serviceAccounts/${SA_EMAIL}`;
const PROJECT = `${CRM}projects/proj`;
const ANCESTORS = ['projects/111', 'folders/10', 'organizations/1'];

const PROVIDER_DATA = {
  name: `${POOL}/providers/gh`,
  state: 'ACTIVE',
  oidc: { issuerUri: 'https://token.actions.githubusercontent.com' },
  attributeMapping: { 'google.subject': 'assertion.sub', 'attribute.repository': 'assertion.repository' },
};

// API の応答と同じ camelCase の形式
const resourceAssets = [
  {
    name: `${CRM}organizations/1`,
    assetType: 'cloudresourcemanager.googleapis.com/Organization',
    resource: { data: { name: 'organizations/1', displayName: 'example.com' } },
    ancestors: ['organizations/1'],
  },
  {
    name: `${CRM}folders/10`,
    assetType: 'cloudresourcemanager.googleapis.com/Folder',
    resource: { data: { name: 'folders/10', displayName: 'Platform' } },
    ancestors: ['folders/10', 'organizations/1'],
  },
  {
    name: `${CRM}projects/111`,
    assetType: 'cloudresourcemanager.googleapis.com/Project',
    resource: { data: { projectId: 'proj', projectNumber: '111', name: 'My Project' } },
    ancestors: ANCESTORS,
  },
  {
    name: '//iam.googleapis.com/projects/proj/serviceAccounts/9001',
    assetType: 'iam.googleapis.com/ServiceAccount',
    resource: { data: { email: SA_EMAIL, uniqueId: '9001' } },
    ancestors: ANCESTORS,
  },
  { name: '//storage.googleapis.com/bucket-a', assetType: 'storage.googleapis.com/Bucket', resource: { data: {} }, ancestors: ANCESTORS },
  { name: '//compute.googleapis.com/projects/proj/zones/z/disks/d', assetType: 'compute.googleapis.com/Disk', resource: { data: {} }, ancestors: ANCESTORS },
  {
    name: `//iam.googleapis.com/${POOL}`,
    assetType: 'iam.googleapis.com/WorkloadIdentityPool',
    resource: { data: { name: POOL, state: 'ACTIVE' } },
    ancestors: ANCESTORS,
  },
  {
    name: `//iam.googleapis.com/${POOL}/providers/gh`,
    assetType: 'iam.googleapis.com/WorkloadIdentityPoolProvider',
    resource: { data: PROVIDER_DATA },
    ancestors: ANCESTORS,
  },
  {
    name: '//iam.googleapis.com/organizations/1/roles/deployer',
    assetType: 'iam.googleapis.com/Role',
    resource: { data: { name: 'organizations/1/roles/deployer', includedPermissions: ['storage.objects.delete'] } },
    ancestors: ['organizations/1'],
  },
];

// GCS に書き出したファイルと同じ snake_case の形式
const policyAssets = [
  {
    name: '//iam.googleapis.com/projects/proj/serviceAccounts/9001',
    asset_type: 'iam.googleapis.com/ServiceAccount',
    iam_policy: { bindings: [{ role: 'roles/iam.workloadIdentityUser', members: [PRINCIPAL, 'user:someone@example.com'] }] },
    ancestors: ANCESTORS,
  },
  {
    name: `${CRM}projects/111`,
    asset_type: 'cloudresourcemanager.googleapis.com/Project',
    iam_policy: {
      bindings: [
        { role: 'organizations/1/roles/deployer', members: [SA, 'group:devs@example.com'] },
        { role: 'roles/storage.objectViewer', members: [SA], condition: { expression: 'request.time < timestamp("2030-01-01T00:00:00Z")', title: 'temporary' } },
      ],
    },
    ancestors: ANCESTORS,
  },
];

const jsonLines = (items: unknown[]) => `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;

const { iamGet } = vi.hoisted(() => ({ iamGet: vi.fn() }));

function fakeGcpClient(): GcpClient {
  const unexpected = () => Promise.reject(new Error('エクスポートからの収集では呼ばない'));
  return { stats: {}, searchResources: unexpected, searchIamPolicies: unexpected, iamGet };
}

const PREDEFINED_ROLES: Record<string, string[]> = {
  'roles/iam.workloadIdentityUser': ['iam.serviceAccounts.getAccessToken'],
  'roles/storage.objectViewer': ['storage.objects.get'],
};

let dir: string;

async function writeExport(resources: unknown[] = resourceAssets, policies: unknown[] = policyAssets) {
  await writeFile(join(dir, 'resource.json'), jsonLines(resources));
  await mkdir(join(dir, 'policies'));
  await writeFile(join(dir, 'policies', 'iam-policy.json.gz'), gzipSync(jsonLines(policies)));
}

beforeEach(async () => {
  vi.clearAllMocks();
  iamGet.mockImplementation(async (path: string) => (PREDEFINED_ROLES[path] ? { includedPermissions: PREDEFINED_ROLES[path] } : undefined));
  dir = await mkdtemp(join(tmpdir(), 'wif-viz-export-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readAssetExport', () => {
  it('project の名前を API の検索結果と同じ project ID の形にし、親と表示名を付ける', async () => {
    await writeExport();
    const exported = await readAssetExport(dir, { orgId: '1' });

    expect(exported.containers).toEqual([
      { name: `${CRM}organizations/1`, type: 'organization', id: '1', displayName: 'example.com' },
      { name: `${CRM}folders/10`, type: 'folder', id: '10', displayName: 'Platform', parent: `${CRM}organizations/1` },
      { name: PROJECT, type: 'project', id: 'proj', projectNumber: '111', displayName: 'My Project', parent: `${CRM}folders/10` },
    ]);
  });

  it('展開対象のアセットタイプだけをインベントリに入れ、SA は email の名前にする', async () => {
    await writeExport();
    const { inventory } = await readAssetExport(dir, { orgId: '1' });

    expect([...inventory].map((r) => r.name).sort()).toEqual([SA_NAME, '//storage.googleapis.com/bucket-a']);
    expect(inventory.list(PROJECT, 'iam.googleapis.com/ServiceAccount')).toEqual([SA_NAME]);
  });

  it('SA と WIF principal へのバインディングだけを member ごとに索引し、付与先の名前と条件を API の検索結果に揃える', async () => {
    await writeExport();
    const { bindingsByMember } = await readAssetExport(dir, { orgId: '1' });

    expect([...bindingsByMember.keys()].sort()).toEqual([PRINCIPAL, SA]);
    expect(bindingsByMember.get(PRINCIPAL)).toEqual([{ resource: SA_NAME, role: 'roles/iam.workloadIdentityUser', member: PRINCIPAL }]);
    expect(bindingsByMember.get(SA)).toEqual([
      { resource: PROJECT, role: 'organizations/1/roles/deployer', member: SA },
      {
        resource: PROJECT,
        role: 'roles/storage.objectViewer',
        member: SA,
        condition: { expression: 'request.time < timestamp("2030-01-01T00:00:00Z")', title: 'temporary' },
      },
    ]);
  });

  it('カスタムロールの permission と、Pool / Provider の詳細をエクスポートから読む', async () => {
    await writeExport();
    const exported = await readAssetExport(dir, { orgId: '1' });

    expect(exported.customRoles).toEqual(new Map([['organizations/1/roles/deployer', ['storage.objects.delete']]]));
    expect(exported.pools).toEqual([{ name: POOL, state: 'ACTIVE' }]);
    expect(exported.providers).toEqual([PROVIDER_DATA]);
  });

  it('ほかの Organization のアセットを含む場合、エラーにする', async () => {
    await writeExport();

    await expect(readAssetExport(dir, { orgId: '2' })).rejects.toThrow('organizations/2 のエクスポートではありません');
  });

  it('1 つのファイルに resource と iam-policy が混在する場合、エラーにする', async () => {
    await writeFile(join(dir, 'mixed.json'), jsonLines([...resourceAssets, ...policyAssets]));
    await writeFile(join(dir, 'policy.json'), jsonLines(policyAssets));

    await expect(readAssetExport(dir, { orgId: '1' })).rejects.toThrow('混在しています');
  });

  it('iam-policy のエクスポートがない場合、エラーにする', async () => {
    await writeFile(join(dir, 'resource.json'), jsonLines(resourceAssets));

    await expect(readAssetExport(dir, { orgId: '1' })).rejects.toThrow('iam-policy のエクスポートがありません');
  });
});

describe('collectSnapshotFromExport', () => {
  it('バインディングの検索 API を呼ばずに探索し、predefined ロールの定義だけを API で取得する', async () => {
    await writeExport();
    const { snapshot, warnings } = await collectSnapshotFromExport(dir, fakeGcpClient(), { orgId: '1', maxDepth: 5 });

    expect(iamGet.mock.calls.map(([path]) => path).sort()).toEqual(['roles/iam.workloadIdentityUser', 'roles/storage.objectViewer']);
    expect(snapshot.roles['organizations/1/roles/deployer']).toEqual(['storage.objects.delete']);
    expect(snapshot.effectiveAccess).toContainEqual(
      expect.objectContaining({
        path: [PRINCIPAL, SA],
        role: 'organizations/1/roles/deployer',
        grantedOn: PROJECT,
        grantedOnKind: 'container',
        assetTypes: ['storage.googleapis.com/Bucket'],
      }),
    );
    expect(snapshot.resourceCounts[PROJECT]).toEqual({ 'iam.googleapis.com/ServiceAccount': 1, 'storage.googleapis.com/Bucket': 1 });
    expect(warnings).toEqual([]);
  });

  it('Provider の種類がエクスポートにない場合、IAM API で詳細を取得する', async () => {
    const withoutKind = resourceAssets.map((asset) =>
      asset.assetType === 'iam.googleapis.com/WorkloadIdentityPoolProvider' ? { ...asset, resource: { data: { name: PROVIDER_DATA.name } } } : asset,
    );
    await writeExport(withoutKind);
    iamGet.mockImplementation(async (path: string) =>
      path === PROVIDER_DATA.name ? PROVIDER_DATA : PREDEFINED_ROLES[path] ? { includedPermissions: PREDEFINED_ROLES[path] } : undefined,
    );

    const { snapshot } = await collectSnapshotFromExport(dir, fakeGcpClient(), { orgId: '1', maxDepth: 5 });

    expect(iamGet).toHaveBeenCalledWith(PROVIDER_DATA.name);
    expect(snapshot.nodes).toContainEqual(expect.objectContaining({ kind: 'provider', provider: expect.objectContaining({ kind: 'oidc' }) }));
  });
});

describe('exportCommands', () => {
  it('resource は読み込むアセットタイプに絞り、iam-policy はすべてを書き出すコマンドを返す', () => {
    const [resource, iamPolicy, download] = exportCommands({ orgId: '1', destination: 'gs://bucket/wif-viz/', billingProject: 'billing', localDir: './export' });

    expect(resource).toMatch(/^gcloud asset export --organization=1 --content-type=resource --asset-types=\S+ --output-path=gs:\/\/bucket\/wif-viz\/resource\.json --billing-project=billing$/);
    for (const type of ['cloudresourcemanager.googleapis.com/Project', 'iam.googleapis.com/WorkloadIdentityPoolProvider', 'iam.googleapis.com/Role', 'iam.googleapis.com/ServiceAccount']) {
      expect(resource).toContain(type);
    }
    expect(iamPolicy).toBe('gcloud asset export --organization=1 --content-type=iam-policy --output-path=gs://bucket/wif-viz/iam-policy.json --billing-project=billing');
    expect(download).toBe("gcloud storage cp 'gs://bucket/wif-viz/*.json' ./export/");
  });
});
