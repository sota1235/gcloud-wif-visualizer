import { describe, expect, it } from 'vitest';
import { edgeId, parseWifPrincipal, serviceAccountEmailFromResource } from '../src/names.ts';

const POOL = 'projects/123/locations/global/workloadIdentityPools/github';

describe('parseWifPrincipal', () => {
  it('attribute の値にスラッシュを含む principalSet を解析できる', () => {
    expect(parseWifPrincipal(`principalSet://iam.googleapis.com/${POOL}/attribute.repository/org/repo`)).toMatchObject({
      principalKind: 'attribute',
      projectNumber: '123',
      poolId: 'github',
      poolName: POOL,
      attributeKey: 'repository',
      value: 'org/repo',
    });
  });

  it('subject の principal を解析できる', () => {
    expect(parseWifPrincipal(`principal://iam.googleapis.com/${POOL}/subject/repo:org/repo:ref:refs/heads/main`)).toMatchObject({
      principalKind: 'subject',
      value: 'repo:org/repo:ref:refs/heads/main',
    });
  });

  it('group と pool 全体（*）を解析できる', () => {
    expect(parseWifPrincipal(`principalSet://iam.googleapis.com/${POOL}/group/admins`)).toMatchObject({ principalKind: 'group', value: 'admins' });
    expect(parseWifPrincipal(`principalSet://iam.googleapis.com/${POOL}/*`)).toMatchObject({ principalKind: 'all' });
  });

  it('WIF 以外の member は undefined を返す', () => {
    expect(parseWifPrincipal('serviceAccount:a@b.iam.gserviceaccount.com')).toBeUndefined();
    expect(parseWifPrincipal('user:someone@example.com')).toBeUndefined();
    // GKE 用の Workload Identity Federation は対象外
    expect(parseWifPrincipal('principalSet://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p.svc.id.goog/namespace/ns')).toBeUndefined();
    expect(parseWifPrincipal('principal://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p.svc.id.goog/subject/ns/default/sa/app')).toBeUndefined();
  });
});

describe('serviceAccountEmailFromResource', () => {
  it('SA のリソース名から email を取り出す', () => {
    expect(serviceAccountEmailFromResource('//iam.googleapis.com/projects/p/serviceAccounts/a@p.iam.gserviceaccount.com')).toBe('a@p.iam.gserviceaccount.com');
    expect(serviceAccountEmailFromResource('//storage.googleapis.com/bucket')).toBeUndefined();
  });
});

describe('edgeId', () => {
  it('長い値はハッシュにして決定的な ID を作る', () => {
    const condition = 'x'.repeat(100);
    expect(edgeId('K', 'a', 'b', condition)).toBe(edgeId('K', 'a', 'b', condition));
    expect(edgeId('K', 'a', 'b', condition)).not.toContain(condition);
    expect(edgeId('K', 'a', 'b', undefined)).toBe('K|a|b|');
  });
});
