import { describe, expect, it } from 'vitest';
import {
  GITHUB_ISSUER,
  ResourceInventory,
  buildAccessGraph,
  computeEffectiveAccess,
  createSnapshot,
  createStaticSource,
  explore,
  type Container,
  type MemberBinding,
} from '@wif-viz/core';
import { downstreamSubgraph, pathSubgraph } from '../src/focus.ts';
import { matchesTerms, narrowToWorkload, reachableRolesAndPermissions, roleFocus, searchAccess } from '../src/role-search.ts';
import { buildViewGraph, grantNodeId } from '../src/view-graph.ts';

const ORG = '//cloudresourcemanager.googleapis.com/organizations/1';
const PROJECT = '//cloudresourcemanager.googleapis.com/projects/proj';
const POOL = 'projects/111/locations/global/workloadIdentityPools/github';
const principal = (repo: string) => `principalSet://iam.googleapis.com/${POOL}/attribute.repository/${repo}`;
const sa = (name: string) => `serviceAccount:${name}@proj.iam.gserviceaccount.com`;
const saResource = (name: string) => `//iam.googleapis.com/projects/proj/serviceAccounts/${name}@proj.iam.gserviceaccount.com`;

const containers: Container[] = [
  { name: ORG, type: 'organization', id: '1' },
  { name: PROJECT, type: 'project', id: 'proj', projectNumber: '111', parent: ORG },
];
const roles: Record<string, string[]> = {
  'roles/iam.workloadIdentityUser': ['iam.serviceAccounts.getAccessToken'],
  'roles/storage.admin': ['storage.buckets.get', 'storage.objects.delete', 'resourcemanager.projects.get'],
  'roles/storage.objectViewer': ['storage.objects.get'],
  'roles/run.admin': ['run.services.create'],
};

async function setup() {
  const bindings: MemberBinding[] = [
    { resource: saResource('deploy'), role: 'roles/iam.workloadIdentityUser', member: principal('org/app') },
    { resource: saResource('deploy'), role: 'roles/iam.workloadIdentityUser', member: principal('org/web') },
    { resource: saResource('reader'), role: 'roles/iam.workloadIdentityUser', member: principal('org/web') },
    { resource: PROJECT, role: 'roles/storage.admin', member: sa('deploy') },
    { resource: PROJECT, role: 'roles/run.admin', member: sa('deploy') },
    { resource: PROJECT, role: 'roles/storage.objectViewer', member: sa('reader') },
    // WIF から到達できない SA の付与は検索対象外
    { resource: PROJECT, role: 'roles/storage.admin', member: sa('unrelated') },
  ];
  const principals = [principal('org/app'), principal('org/web')];
  const explored = await explore(
    principals,
    createStaticSource({
      containers,
      serviceAccounts: ['deploy', 'reader', 'unrelated'].map((n) => ({ email: `${n}@proj.iam.gserviceaccount.com`, project: PROJECT })),
      bindings,
      roles,
    }),
    { maxDepth: 5 },
  );
  const provider = {
    name: `${POOL}/providers/github`,
    poolName: POOL,
    providerId: 'github',
    kind: 'oidc' as const,
    issuerUri: GITHUB_ISSUER,
    attributeMapping: { 'google.subject': 'assertion.sub', 'attribute.repository': 'assertion.repository' },
    disabled: false,
  };
  const graph = buildAccessGraph({ pools: [], providers: [provider], containers, explored });
  const inventory = new ResourceInventory(containers, [
    { name: '//storage.googleapis.com/a', assetType: 'storage.googleapis.com/Bucket', ancestors: ['projects/111', 'organizations/1'] },
    { name: '//storage.googleapis.com/b', assetType: 'storage.googleapis.com/Bucket', ancestors: ['projects/111', 'organizations/1'] },
  ]);
  const snapshot = createSnapshot({
    org: { id: '1' },
    collectedAt: new Date('2026-10-20T00:00:00Z'),
    options: { maxDepth: 5 },
    roles,
    graph,
    effectiveAccess: computeEffectiveAccess(graph, { rolePermissions: roles }),
    inventory,
  });
  return { snapshot, view: buildViewGraph(snapshot) };
}

describe('matchesTerms', () => {
  it('大文字小文字を区別せず、空白区切りのすべての語を含むものに一致する', () => {
    expect(matchesTerms('roles/storage.objectViewer', 'STORAGE viewer')).toBe(true);
    expect(matchesTerms('roles/storage.admin', 'storage viewer')).toBe(false);
    expect(matchesTerms('roles/storage.admin', '  ')).toBe(false);
  });
});

describe('searchRoles', () => {
  it('一致したロールごとに、到達できる Workload・付与・リソース数をまとめる', async () => {
    const { snapshot, view } = await setup();
    const matches = searchAccess(snapshot, view, 'storage');

    expect(matches.map((m) => m.role)).toEqual(['roles/storage.admin', 'roles/storage.objectViewer']);
    expect(matches[0]).toMatchObject({
      grants: [{ viewNodeId: grantNodeId(sa('deploy'), PROJECT), identity: sa('deploy'), grantedOn: PROJECT }],
      resourceCount: 2,
    });
    // storage.admin は org/app と org/web の両方から到達できる
    expect(matches[0]?.workloads).toHaveLength(2);
    expect(matches[1]?.workloads).toHaveLength(1);
  });

  it('WIF から到達できない identity の付与は含めない', async () => {
    const { snapshot, view } = await setup();
    const [admin] = searchAccess(snapshot, view, 'storage.admin');

    expect(admin?.grants.map((g) => g.identity)).toEqual([sa('deploy')]);
  });

  it('SA への付与は SA ノードに対応づける', async () => {
    const { snapshot, view } = await setup();
    const [wifUser] = searchAccess(snapshot, view, 'workloadIdentityUser');

    // principal ごとに別の付与として数え、表示上は付与先の SA ノードに対応づける
    expect(wifUser?.grants.map((g) => [g.identity, g.viewNodeId])).toEqual([
      [principal('org/app'), sa('deploy')],
      [principal('org/web'), sa('deploy')],
      [principal('org/web'), sa('reader')],
    ]);
  });

  it('一致しない場合は空', async () => {
    const { snapshot, view } = await setup();

    expect(searchAccess(snapshot, view, 'bigquery')).toEqual([]);
  });
});

describe('roleFocus', () => {
  it('付与先を強調し、一致したロールで到達できるリソースのまとまりだけを含める', async () => {
    const { snapshot, view } = await setup();
    const storage = roleFocus(searchAccess(snapshot, view, 'storage.admin'), view);
    const run = roleFocus(searchAccess(snapshot, view, 'run.admin'), view);

    expect(storage.highlight).toEqual([grantNodeId(sa('deploy'), PROJECT)]);
    expect(storage.upstreamFrom).toContain(`rg|${sa('deploy')}|${PROJECT}|storage.googleapis.com/Bucket`);
    // run.admin と同じ付与先にあるバケットは、run.admin では操作できないので含めない
    expect(run.upstreamFrom).toEqual([grantNodeId(sa('deploy'), PROJECT)]);
  });
});

describe('searchAccess（permission）', () => {
  it('一致する permission を含むロールを列挙し、一致した permission と対象アセットタイプを付ける', async () => {
    const { snapshot, view } = await setup();
    const matches = searchAccess(snapshot, view, 'storage.objects', 'permission');

    expect(matches.map((m) => [m.role, m.matchedPermissions, m.assetTypes])).toEqual([
      ['roles/storage.admin', ['storage.objects.delete'], ['storage.googleapis.com/Bucket']],
      ['roles/storage.objectViewer', ['storage.objects.get'], ['storage.googleapis.com/Bucket']],
    ]);
  });

  it('リソースに展開できない permission では、リソースを数えずグラフにも出さない', async () => {
    const { snapshot, view } = await setup();
    const matches = searchAccess(snapshot, view, 'resourcemanager.projects.get', 'permission');

    expect(matches).toMatchObject([{ role: 'roles/storage.admin', assetTypes: [], resourceCount: 0 }]);
    expect(roleFocus(matches, view).upstreamFrom).toEqual([grantNodeId(sa('deploy'), PROJECT)]);
  });

  it('ロールの検索と同様に、WIF から到達できない付与は含めない', async () => {
    const { snapshot, view } = await setup();
    const [admin] = searchAccess(snapshot, view, 'storage.objects.delete', 'permission');

    expect(admin?.grants.map((g) => g.identity)).toEqual([sa('deploy')]);
  });
});

describe('reachableRolesAndPermissions', () => {
  it('WIF から到達できるロールと、その permission を入力候補として返す', async () => {
    const { snapshot } = await setup();
    const { roles: reachableRoles, permissions } = reachableRolesAndPermissions(snapshot);

    expect(reachableRoles).toEqual(['roles/iam.workloadIdentityUser', 'roles/run.admin', 'roles/storage.admin', 'roles/storage.objectViewer']);
    expect(permissions).toContain('storage.objects.delete');
    expect(permissions).toEqual([...permissions].sort());
  });
});

describe('narrowToWorkload', () => {
  // principal に解決されるワークロード
  const workloadId = (view: Awaited<ReturnType<typeof setup>>['view'], repo: string) =>
    view.edges.find((e) => e.kind === 'resolves' && e.target === principal(repo))!.source;

  it('ワークロードの principal から到達できない付与とロールを除く', async () => {
    const { snapshot, view } = await setup();
    const app = workloadId(view, 'org/app');
    const narrowed = narrowToWorkload(searchAccess(snapshot, view, 'storage'), view, app);

    // storage.objectViewer は org/web からしか到達できない
    expect(narrowed.map((m) => [m.role, m.workloads, m.grants.map((g) => g.identity)])).toEqual([['roles/storage.admin', [app], [sa('deploy')]]]);
  });

  it('絞り込んだ経路を表示するとき、同じ SA に到達するほかのワークロードを含めない', async () => {
    const { snapshot, view } = await setup();
    const app = workloadId(view, 'org/app');
    const focus = roleFocus(narrowToWorkload(searchAccess(snapshot, view, 'storage.admin'), view, app), view);
    const graph = downstreamSubgraph(pathSubgraph(view, focus.upstreamFrom, focus.downstreamFrom), app);

    expect(graph.nodes.has(app)).toBe(true);
    expect(graph.nodes.has(workloadId(view, 'org/web'))).toBe(false);
    expect(graph.nodes.has(principal('org/web'))).toBe(false);
    expect(graph.nodes.has(grantNodeId(sa('deploy'), PROJECT))).toBe(true);
    expect(graph.nodes.has(`rg|${sa('deploy')}|${PROJECT}|storage.googleapis.com/Bucket`)).toBe(true);
  });
});
