import { describe, expect, it } from 'vitest';
import { existingServiceAccountsOf, toContainer, toMemberBindings, toPool, toProvider } from '../src/collect.ts';

describe('API レスポンスの変換', () => {
  it('project の検索結果を container に変換する', () => {
    expect(
      toContainer({
        assetType: 'cloudresourcemanager.googleapis.com/Project',
        name: '//cloudresourcemanager.googleapis.com/projects/my-proj',
        project: 'projects/123',
        displayName: 'My Project',
        parentFullResourceName: '//cloudresourcemanager.googleapis.com/folders/10',
      }),
    ).toEqual({
      name: '//cloudresourcemanager.googleapis.com/projects/my-proj',
      type: 'project',
      id: 'my-proj',
      projectNumber: '123',
      displayName: 'My Project',
      parent: '//cloudresourcemanager.googleapis.com/folders/10',
    });
  });

  it('IAM ポリシーの検索結果を member ごとのバインディングに分解し、条件を保持する', () => {
    const bindings = toMemberBindings(
      [
        {
          resource: '//iam.googleapis.com/projects/p/serviceAccounts/sa@p.iam.gserviceaccount.com',
          policy: {
            bindings: [
              { role: 'roles/iam.workloadIdentityUser', members: ['principalSet://x', 'user:a@example.com'], condition: { expression: 'true', title: 't' } },
            ],
          },
        },
      ],
      (m) => m.startsWith('principalSet://'),
    );

    expect(bindings).toEqual([
      {
        resource: '//iam.googleapis.com/projects/p/serviceAccounts/sa@p.iam.gserviceaccount.com',
        role: 'roles/iam.workloadIdentityUser',
        member: 'principalSet://x',
        condition: { expression: 'true', title: 't' },
      },
    ]);
  });

  it('Pool / Provider を変換し、DELETED を無効として扱う', () => {
    expect(toPool({ name: 'projects/1/locations/global/workloadIdentityPools/github', state: 'DELETED' })).toEqual({
      name: 'projects/1/locations/global/workloadIdentityPools/github',
      projectNumber: '1',
      poolId: 'github',
      disabled: true,
    });
    expect(
      toProvider({
        name: 'projects/1/locations/global/workloadIdentityPools/github/providers/gh',
        state: 'ACTIVE',
        oidc: { issuerUri: 'https://token.actions.githubusercontent.com' },
        attributeMapping: { 'google.subject': 'assertion.sub' },
      }),
    ).toMatchObject({ poolName: 'projects/1/locations/global/workloadIdentityPools/github', providerId: 'gh', kind: 'oidc', disabled: false });
  });
});

describe('existingServiceAccountsOf', () => {
  it('Org 内の project の SA でインベントリにないものだけを存在しないとみなす', () => {
    const existing = existingServiceAccountsOf(
      {
        bindings: [],
        depth: new Map([
          ['serviceAccount:live@proj.iam.gserviceaccount.com', 1],
          ['serviceAccount:deleted@proj.iam.gserviceaccount.com', 1],
          ['serviceAccount:service-1@gcp-sa-run.iam.gserviceaccount.com', 1],
          ['serviceAccount:other@external.iam.gserviceaccount.com', 1],
        ]),
        serviceAccountEdges: [],
      },
      [{ name: '//iam.googleapis.com/projects/proj/serviceAccounts/live@proj.iam.gserviceaccount.com', assetType: 'iam.googleapis.com/ServiceAccount', folders: [] }],
      [{ name: '//cloudresourcemanager.googleapis.com/projects/proj', type: 'project', id: 'proj', projectNumber: '1' }],
    );

    expect([...existing].sort()).toEqual([
      'live@proj.iam.gserviceaccount.com',
      'other@external.iam.gserviceaccount.com',
      'service-1@gcp-sa-run.iam.gserviceaccount.com',
    ]);
  });
});
