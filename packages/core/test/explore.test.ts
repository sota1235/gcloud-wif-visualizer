import { describe, expect, it } from 'vitest';
import { computeEffectiveAccess } from '../src/effective.ts';
import { explore } from '../src/explore.ts';
import { buildAccessGraph } from '../src/graph.ts';
import { createStaticSource } from '../src/source.ts';
import type { MemberBinding } from '../src/types.ts';
import { containers, FOLDER, ORG, PROJECT_A, PROJECT_B, REPO_PRINCIPAL, roles, sa, saMember, saResource, source } from './fixtures.ts';

const BUCKET = '//storage.googleapis.com/projects/_/buckets/data';

async function run(bindings: MemberBinding[], maxDepth = 5) {
  const explored = await explore([REPO_PRINCIPAL], createStaticSource(source(bindings)), { maxDepth });
  const graph = buildAccessGraph({ pools: [], providers: [], containers, explored });
  return { explored, graph, access: computeEffectiveAccess(graph, { inventory: [], rolePermissions: roles }) };
}

const wifUser = (target: string): MemberBinding => ({ resource: target, role: 'roles/iam.workloadIdentityUser', member: REPO_PRINCIPAL });
const summarize = (access: Awaited<ReturnType<typeof run>>['access']) =>
  access.map((a) => ({ path: a.path, role: a.role, grantedOn: a.grantedOn, conditional: a.conditional }));

describe('explore', () => {
  it('principal → SA → リソースの経路を求める', async () => {
    const { access } = await run([
      wifUser(saResource('deploy')),
      { resource: PROJECT_A, role: 'roles/storage.admin', member: saMember('deploy') },
    ]);

    expect(summarize(access)).toContainEqual({
      path: [REPO_PRINCIPAL, saMember('deploy')],
      role: 'roles/storage.admin',
      grantedOn: PROJECT_A,
      conditional: false,
    });
  });

  it('principal に直接付与されたロールも実効アクセスになる', async () => {
    const { access } = await run([{ resource: BUCKET, role: 'roles/storage.admin', member: REPO_PRINCIPAL }]);

    expect(summarize(access)).toEqual([{ path: [REPO_PRINCIPAL], role: 'roles/storage.admin', grantedOn: BUCKET, conditional: false }]);
  });

  it('多段の impersonation を辿る', async () => {
    const { access, explored } = await run([
      wifUser(saResource('deploy')),
      { resource: saResource('admin', 'b'), role: 'roles/iam.serviceAccountTokenCreator', member: saMember('deploy') },
      { resource: ORG, role: 'roles/viewer', member: saMember('admin', 'b') },
    ]);

    expect(explored.depth.get(saMember('admin', 'b'))).toBe(2);
    expect(summarize(access)).toContainEqual({
      path: [REPO_PRINCIPAL, saMember('deploy'), saMember('admin', 'b')],
      role: 'roles/viewer',
      grantedOn: ORG,
      conditional: false,
    });
  });

  it('container に付与された impersonation 権限は配下（folder 経由を含む）の全 SA に及ぶ', async () => {
    const { explored } = await run([
      wifUser(saResource('deploy')),
      { resource: FOLDER, role: 'roles/iam.serviceAccountTokenCreator', member: saMember('deploy') },
    ]);

    const targets = explored.serviceAccountEdges.filter((e) => e.kind === 'CAN_IMPERSONATE' && e.from === saMember('deploy'));
    // FOLDER 配下は PROJECT_A の SA のみ。自分自身（deploy）は除外する
    expect(targets.map((e) => e.to)).toEqual([saMember('runtime')]);
    expect(targets[0]?.grantedOn).toBe(FOLDER);
  });

  it('循環と self-loop があっても停止する', async () => {
    const { explored } = await run([
      wifUser(saResource('deploy')),
      { resource: saResource('deploy'), role: 'roles/iam.serviceAccountTokenCreator', member: saMember('deploy') },
      { resource: saResource('runtime'), role: 'roles/iam.serviceAccountTokenCreator', member: saMember('deploy') },
      { resource: saResource('deploy'), role: 'roles/iam.serviceAccountTokenCreator', member: saMember('runtime') },
    ]);

    expect(explored.serviceAccountEdges.map((e) => [e.from, e.to])).toEqual(
      expect.arrayContaining([
        [saMember('deploy'), saMember('runtime')],
        [saMember('runtime'), saMember('deploy')],
      ]),
    );
    expect(explored.serviceAccountEdges.some((e) => e.from === e.to)).toBe(false);
  });

  it('maxDepth を超える SA はバインディングを取得せず truncated にする', async () => {
    const { explored, access } = await run(
      [
        wifUser(saResource('deploy')),
        { resource: saResource('admin', 'b'), role: 'roles/iam.serviceAccountTokenCreator', member: saMember('deploy') },
        { resource: ORG, role: 'roles/viewer', member: saMember('admin', 'b') },
      ],
      1,
    );

    expect(explored.truncated).toEqual(new Set([saMember('admin', 'b')]));
    expect(access.some((a) => a.path.includes(saMember('admin', 'b')))).toBe(false);
  });

  it('カスタムロールも permission で判定する。actAs は記録するが辿らない', async () => {
    const { explored } = await run([
      { resource: saResource('deploy'), role: 'organizations/1/roles/customImpersonator', member: REPO_PRINCIPAL },
      { resource: PROJECT_B, role: 'organizations/1/roles/customDeployer', member: saMember('deploy') },
      { resource: ORG, role: 'roles/viewer', member: saMember('admin', 'b') },
    ]);

    const actAs = explored.serviceAccountEdges.filter((e) => e.kind === 'CAN_ACT_AS');
    expect(actAs.map((e) => e.to).sort()).toEqual([saMember('admin', 'b'), saMember('other', 'b')]);
    expect(explored.depth.has(saMember('admin', 'b'))).toBe(false);
  });

  it('SA の鍵を作れるロールは impersonation とみなす', async () => {
    const { explored } = await run([
      wifUser(saResource('deploy')),
      { resource: saResource('runtime'), role: 'roles/iam.serviceAccountKeyAdmin', member: saMember('deploy') },
    ]);

    expect(explored.depth.get(saMember('runtime'))).toBe(2);
  });

  it('経路上の IAM Condition を conditional として伝播する', async () => {
    const condition = { expression: 'request.time < timestamp("2027-01-01T00:00:00Z")' };
    const { access } = await run([
      wifUser(saResource('deploy')),
      { resource: saResource('runtime'), role: 'roles/iam.serviceAccountTokenCreator', member: saMember('deploy'), condition },
      { resource: PROJECT_A, role: 'roles/storage.admin', member: saMember('runtime') },
      { resource: PROJECT_A, role: 'roles/viewer', member: saMember('deploy') },
    ]);

    const byRole = Object.fromEntries(summarize(access).map((a) => [a.role, a.conditional]));
    expect(byRole).toMatchObject({ 'roles/storage.admin': true, 'roles/viewer': false });
  });

  it('同じ SA への付与に条件なしのものがあれば無条件とみなす', async () => {
    const condition = { expression: 'resource.name.startsWith("x")' };
    const { access } = await run([
      wifUser(saResource('deploy')),
      { ...wifUser(saResource('deploy')), role: 'roles/iam.serviceAccountTokenCreator', condition },
      { resource: PROJECT_A, role: 'roles/storage.admin', member: saMember('deploy') },
    ]);

    expect(access.find((a) => a.role === 'roles/storage.admin')?.conditional).toBe(false);
  });
});

describe('buildAccessGraph', () => {
  it('SA への付与は SA ノード（member 形式）を付与先にし、元のリソース名を保持する', async () => {
    const { graph } = await run([wifUser(saResource('deploy'))]);
    const edge = [...graph.edges.values()].find((e) => e.kind === 'HAS_ROLE');

    expect(edge).toMatchObject({ from: REPO_PRINCIPAL, to: saMember('deploy'), resource: saResource('deploy') });
    expect(graph.nodes.get(saMember('deploy'))).toMatchObject({ kind: 'serviceAccount', email: sa('deploy') });
  });

  it('existingServiceAccounts にない SA を missing にする', async () => {
    const explored = await explore([REPO_PRINCIPAL], createStaticSource(source([wifUser(saResource('deleted'))])), { maxDepth: 5 });
    const graph = buildAccessGraph({ pools: [], providers: [], containers, explored, existingServiceAccounts: new Set([sa('deploy')]) });

    expect(graph.nodes.get(saMember('deleted'))).toMatchObject({ missing: true });
  });

  it('同じ入力から同じ ID を生成する', async () => {
    const bindings = [wifUser(saResource('deploy')), { resource: PROJECT_B, role: 'roles/viewer', member: saMember('deploy') }];
    const first = await run(bindings);
    const second = await run([...bindings].reverse());

    expect([...second.graph.edges.keys()].sort()).toEqual([...first.graph.edges.keys()].sort());
    expect(second.access.map((a) => a.id)).toEqual(first.access.map((a) => a.id));
  });
});
