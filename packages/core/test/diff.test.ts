import { describe, expect, it } from 'vitest';
import { diffSnapshots, isEmptyDiff } from '../src/diff.ts';
import { ResourceInventory } from '../src/inventory.ts';
import type { MemberBinding } from '../src/types.ts';
import { containers, inventoryResource, PROJECT_A, PROJECT_B, REPO_PRINCIPAL, saMember, saResource } from './fixtures.ts';
import { buildSnapshot, githubProvider } from './helpers.ts';

const wifUser: MemberBinding = { resource: saResource('deploy'), role: 'roles/iam.workloadIdentityUser', member: REPO_PRINCIPAL };
const storageAdmin: MemberBinding = { resource: PROJECT_A, role: 'roles/storage.admin', member: saMember('deploy') };
const bucket = (name: string) => inventoryResource(`//storage.googleapis.com/${name}`, 'storage.googleapis.com/Bucket');

describe('diffSnapshots', () => {
  it('同じ構成なら差分なし', async () => {
    const base = await buildSnapshot({ bindings: [wifUser, storageAdmin] });
    const head = await buildSnapshot({ bindings: [wifUser, storageAdmin], collectedAt: '2026-10-20T00:00:00Z' });

    expect(isEmptyDiff(diffSnapshots(base, head))).toBe(true);
  });

  it('実効アクセスの追加・削除と、Lint の発生・解消を検出する', async () => {
    const base = await buildSnapshot({ bindings: [wifUser, storageAdmin] });
    const head = await buildSnapshot({ bindings: [wifUser, { resource: PROJECT_B, role: 'roles/editor', member: saMember('deploy') }] });
    const diff = diffSnapshots(base, head);

    expect(diff.access.added.map((a) => [a.role, a.grantedOn])).toEqual([['roles/editor', PROJECT_B]]);
    expect(diff.access.removed.map((a) => [a.role, a.grantedOn])).toEqual([['roles/storage.admin', PROJECT_A]]);
    expect(diff.findings.added.map((f) => f.ruleId)).toEqual(['primitive-role']);
    expect(diff.findings.resolved).toEqual([]);
    expect(diffSnapshots(head, base).findings.resolved.map((f) => f.ruleId)).toEqual(['primitive-role']);
  });

  it('同じ付与で到達できるリソースの数が変わった場合は、件数付きで changed にする', async () => {
    const base = await buildSnapshot({ bindings: [wifUser, storageAdmin], inventory: [bucket('a')] });
    const head = await buildSnapshot({ bindings: [wifUser, storageAdmin], inventory: [bucket('a'), bucket('b')] });
    const changed = diffSnapshots(base, head).access.changed;

    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ resourceCount: { before: 1, after: 2 }, conditionalChanged: false });
    expect(changed[0]?.addedResources).toBeUndefined();
  });

  it('インベントリを渡した場合、件数が同じでも入れ替わったリソースを名前で検出する', async () => {
    const baseInventory = [bucket('a'), bucket('b')];
    const headInventory = [bucket('b'), bucket('c')];
    const base = await buildSnapshot({ bindings: [wifUser, storageAdmin], inventory: baseInventory });
    const head = await buildSnapshot({ bindings: [wifUser, storageAdmin], inventory: headInventory });

    expect(diffSnapshots(base, head).access.changed).toEqual([]);
    const inventories = { base: new ResourceInventory(containers, baseInventory), head: new ResourceInventory(containers, headInventory) };
    expect(diffSnapshots(base, head, { inventories }).access.changed).toMatchObject([
      {
        resourceCount: { before: 2, after: 2 },
        addedResources: ['//storage.googleapis.com/c'],
        removedResources: ['//storage.googleapis.com/a'],
      },
    ]);
  });

  it('IAM Condition の有無の変化を changed にする', async () => {
    const conditional = { ...storageAdmin, condition: { expression: 'request.time < timestamp("2027-01-01T00:00:00Z")' } };
    const diff = diffSnapshots(await buildSnapshot({ bindings: [wifUser, storageAdmin] }), await buildSnapshot({ bindings: [wifUser, conditional] }));

    expect(diff.access.changed.map((c) => c.conditionalChanged)).toEqual([true]);
  });

  it('Provider の設定変更を、変更されたフィールド付きで検出する', async () => {
    const base = await buildSnapshot({ bindings: [wifUser] });
    const head = await buildSnapshot({
      bindings: [wifUser],
      providers: [githubProvider({ attributeCondition: "assertion.repository_owner_id == '2'" })],
    });

    expect(diffSnapshots(base, head).providers.changed.map((c) => c.fields)).toEqual([['attributeCondition']]);
  });

  it('異なる Org のスナップショットは比較しない', async () => {
    const base = await buildSnapshot({ bindings: [wifUser] });

    expect(() => diffSnapshots(base, { ...base, org: { id: '2' } })).toThrow(/different organizations/);
  });
});
