import { describe, expect, it } from 'vitest';
import { diffSnapshots, isEmptyDiff } from '../src/diff.ts';
import type { InventoryResource, MemberBinding } from '../src/types.ts';
import { PROJECT_A, PROJECT_B, REPO_PRINCIPAL, saMember, saResource } from './fixtures.ts';
import { buildSnapshot, githubProvider } from './helpers.ts';

const wifUser: MemberBinding = { resource: saResource('deploy'), role: 'roles/iam.workloadIdentityUser', member: REPO_PRINCIPAL };
const storageAdmin: MemberBinding = { resource: PROJECT_A, role: 'roles/storage.admin', member: saMember('deploy') };
const bucket = (name: string): InventoryResource => ({
  name: `//storage.googleapis.com/${name}`,
  assetType: 'storage.googleapis.com/Bucket',
  project: 'projects/111',
  folders: ['folders/10'],
  organization: 'organizations/1',
});

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

  it('同じ付与で到達できるリソースが増減した場合は changed にする', async () => {
    const base = await buildSnapshot({ bindings: [wifUser, storageAdmin], inventory: [bucket('a'), bucket('b')] });
    const head = await buildSnapshot({ bindings: [wifUser, storageAdmin], inventory: [bucket('b'), bucket('c')] });
    const [change] = diffSnapshots(base, head).access.changed;

    expect(change).toMatchObject({
      addedResources: ['//storage.googleapis.com/c'],
      removedResources: ['//storage.googleapis.com/a'],
      conditionalChanged: false,
    });
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
