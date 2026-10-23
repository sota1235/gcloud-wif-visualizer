import { describe, expect, it } from 'vitest';
import { findingsOf } from '../src/diff.ts';
import type { MemberBinding } from '../src/types.ts';
import { ALL_PRINCIPAL, FOLDER, inventoryResource, ORG, PROJECT_A, PROJECT_B, REPO_PRINCIPAL, sa, saMember, saResource } from './fixtures.ts';
import { buildSnapshot, githubProvider, pool, type SnapshotInput } from './helpers.ts';

const wifUser = (name: string, member = REPO_PRINCIPAL): MemberBinding => ({ resource: saResource(name), role: 'roles/iam.workloadIdentityUser', member });
const deployHas = (role: string, resource = PROJECT_A): MemberBinding => ({ resource, role, member: saMember('deploy') });

async function findings(input: SnapshotInput) {
  return findingsOf(await buildSnapshot(input));
}
const rules = async (input: SnapshotInput) => (await findings(input)).map((f) => f.ruleId).sort();

describe('lint', () => {
  it('問題のない構成では何も検出しない', async () => {
    expect(await findings({ bindings: [wifUser('deploy'), deployHas('roles/storage.admin')] })).toEqual([]);
  });

  it('primitive-role: 基本ロールへの到達を、影響範囲付きで検出する', async () => {
    const [finding] = await findings({
      bindings: [wifUser('deploy'), deployHas('roles/editor')],
      inventory: [
        inventoryResource('//storage.googleapis.com/a', 'storage.googleapis.com/Bucket'),
        inventoryResource('//storage.googleapis.com/b', 'storage.googleapis.com/Bucket', 'b'),
      ],
    });

    expect(finding).toMatchObject({
      ruleId: 'primitive-role',
      severity: 'high',
      cause: { kind: 'binding', ref: saMember('deploy'), role: 'roles/editor', grantedOn: PROJECT_A },
      impact: { principals: [REPO_PRINCIPAL], resourceCount: 1 },
    });
    expect(finding?.impact.workloads).toHaveLength(1);
  });

  it('iam-admin-reachable: IAM を書き換えられるロールを検出する。owner は primitive-role だけにする', async () => {
    expect(await rules({ bindings: [wifUser('deploy'), deployHas('roles/resourcemanager.projectIamAdmin')] })).toEqual(['iam-admin-reachable']);
    expect(await rules({ bindings: [wifUser('deploy'), deployHas('roles/owner')] })).toEqual(['primitive-role']);
  });

  it('WIF から到達できない identity のロールは検出しない', async () => {
    expect(await rules({ bindings: [wifUser('deploy'), { resource: PROJECT_B, role: 'roles/editor', member: saMember('admin', 'b') }] })).toEqual([]);
  });

  it('act-as-reachable: actAs 先の SA が強い権限を持つ場合は high にする', async () => {
    const actAs = { resource: PROJECT_B, role: 'roles/iam.serviceAccountUser', member: saMember('deploy') };
    const [medium] = await findings({ bindings: [wifUser('deploy'), actAs] });
    const [high] = await findings({
      bindings: [wifUser('deploy'), actAs, { resource: ORG, role: 'roles/owner', member: saMember('admin', 'b') }],
    });

    expect(medium).toMatchObject({ ruleId: 'act-as-reachable', severity: 'medium', nodeIds: [saMember('deploy'), saMember('admin', 'b'), saMember('other', 'b')] });
    expect(high).toMatchObject({ ruleId: 'act-as-reachable', severity: 'high' });
  });

  it('org-level-token-creator: folder / org への impersonation 権限を検出し、project への付与は対象外にする', async () => {
    const tokenCreator = (resource: string) => deployHas('roles/iam.serviceAccountTokenCreator', resource);

    expect(await rules({ bindings: [wifUser('deploy'), tokenCreator(FOLDER)] })).toContain('org-level-token-creator');
    expect(await rules({ bindings: [wifUser('deploy'), tokenCreator(PROJECT_B)] })).not.toContain('org-level-token-creator');
  });

  it('deep-impersonation-chain: SA を 2 段以上辿る経路を検出する', async () => {
    const [finding] = await findings({
      bindings: [
        wifUser('deploy'),
        { resource: saResource('runtime'), role: 'roles/iam.serviceAccountTokenCreator', member: saMember('deploy') },
        { resource: PROJECT_A, role: 'roles/storage.admin', member: saMember('runtime') },
      ],
    });

    expect(finding).toMatchObject({ ruleId: 'deep-impersonation-chain', nodeIds: [REPO_PRINCIPAL, saMember('deploy'), saMember('runtime')] });
  });

  it('wildcard-principal-set: Pool 全体への付与を検出する', async () => {
    expect(await rules({ bindings: [wifUser('deploy', ALL_PRINCIPAL)] })).toContain('wildcard-principal-set');
  });

  it('dangling-principal / disabled-but-bound: Pool の不在・無効化、SA の不在を検出する', async () => {
    expect(await rules({ bindings: [wifUser('deploy')], pools: [], providers: [] })).toEqual(['dangling-principal']);
    expect(await rules({ bindings: [wifUser('deploy')], pools: [pool({ disabled: true })] })).toEqual(['disabled-but-bound']);
    expect(await rules({ bindings: [wifUser('deploy')], existingServiceAccounts: new Set([sa('runtime')]) })).toEqual(['disabled-but-bound']);
  });

  it('github-missing-attribute-condition / github-name-based-trust: 条件がなく名前だけで信頼している Provider を検出する', async () => {
    const result = await rules({ bindings: [wifUser('deploy')], providers: [githubProvider({ attributeCondition: undefined })] });

    expect(result).toEqual(['github-missing-attribute-condition', 'github-name-based-trust']);
  });

  it('github-name-based-trust: ID で制限していれば検出しない', async () => {
    const byName = githubProvider({ attributeCondition: "assertion.repository_owner == 'org'" });

    expect(await rules({ bindings: [wifUser('deploy')], providers: [byName] })).toEqual(['github-name-based-trust']);
    expect(await rules({ bindings: [wifUser('deploy')] })).toEqual([]);
  });

  it('github-actor-based-trust: condition の actor 依存を検出する', async () => {
    const provider = githubProvider({ attributeCondition: "assertion.repository_owner_id == '1' && attribute.actor == 'alice'" });

    expect(await rules({ bindings: [wifUser('deploy')], providers: [provider] })).toEqual(['github-actor-based-trust']);
  });

  it('unreachable-principal: condition と矛盾する principal を検出する', async () => {
    const provider = githubProvider({ attributeCondition: "assertion.repository_owner_id == '1' && attribute.repository == 'org/other'" });

    expect(await rules({ bindings: [wifUser('deploy')], providers: [provider] })).toEqual(['unreachable-principal']);
  });

  it('重要度、影響するリソース数の順に並べ、ID は決定的にする', async () => {
    const input: SnapshotInput = {
      bindings: [wifUser('deploy'), deployHas('roles/editor'), { resource: PROJECT_B, role: 'roles/iam.serviceAccountUser', member: saMember('deploy') }],
      providers: [githubProvider({ attributeCondition: "assertion.repository_owner_id == '1' && attribute.actor == 'alice'" })],
    };
    const first = await findings(input);
    const second = await findings({ ...input, bindings: [...input.bindings].reverse() });

    expect(first.map((f) => f.severity)).toEqual(['high', 'medium', 'low']);
    expect(second.map((f) => f.id)).toEqual(first.map((f) => f.id));
    expect(first.every((f) => f.id.includes(f.ruleId))).toBe(true);
  });
});
