import { describe, expect, it } from 'vitest';
import { explore } from '../src/explore.ts';
import { buildAccessGraph } from '../src/graph.ts';
import { parseWifPrincipal } from '../src/names.ts';
import { createStaticSource } from '../src/source.ts';
import type { PrincipalNode, WorkloadIdentityPoolProvider } from '../src/types.ts';
import { GITHUB_ISSUER, inferWorkload, inferWorkloads, parseGitHubSubject } from '../src/workload.ts';
import { containers, POOL, REPO_PRINCIPAL, saResource, source } from './fixtures.ts';

const GITHUB_MAPPING = {
  'google.subject': 'assertion.sub',
  'attribute.repository': 'assertion.repository',
  'attribute.repository_owner': 'assertion.repository_owner',
  'attribute.environment': 'assertion.environment',
  'attribute.actor': 'assertion.actor',
};

const provider = (overrides: Partial<WorkloadIdentityPoolProvider> = {}): WorkloadIdentityPoolProvider => ({
  name: `${POOL}/providers/github`,
  poolName: POOL,
  providerId: 'github',
  kind: 'oidc',
  issuerUri: GITHUB_ISSUER,
  attributeMapping: GITHUB_MAPPING,
  disabled: false,
  ...overrides,
});

const principal = (suffix: string): PrincipalNode => {
  const scheme = suffix.startsWith('subject/') ? 'principal' : 'principalSet';
  const parsed = parseWifPrincipal(`${scheme}://iam.googleapis.com/${POOL}/${suffix}`);
  if (!parsed) throw new Error(`invalid principal: ${suffix}`);
  return parsed;
};

describe('inferWorkload（GitHub）', () => {
  it('principal の attribute と attributeCondition を組み合わせて repo と environment を特定する', () => {
    const workload = inferWorkload(
      principal('attribute.environment/terraform-plan'),
      provider({ attributeCondition: `('alice'==attribute.actor || 'renovate[bot]'==attribute.actor) && 'org/infra'==attribute.repository` }),
    );

    expect(workload).toMatchObject({
      idp: 'github',
      label: 'GitHub org/infra (environment: terraform-plan)',
      github: { owner: 'org', repository: 'org/infra', environments: ['terraform-plan'], actors: ['alice', 'renovate[bot]'] },
      unreachable: false,
      confidence: 'exact',
    });
  });

  it('subject principal の sub claim を分解する', () => {
    expect(inferWorkload(principal('subject/repo:org/app:ref:refs/heads/main'), provider())).toMatchObject({
      label: 'GitHub org/app (ref: refs/heads/main)',
      github: { repository: 'org/app', refs: ['refs/heads/main'] },
    });
    expect(inferWorkload(principal('subject/repo:org/app:environment:prod'), provider()).label).toBe('GitHub org/app (environment: prod)');
    expect(inferWorkload(principal('subject/repo:org/app:pull_request'), provider()).github?.pullRequest).toBe(true);
  });

  it('owner 単位や pool 全体の principal は範囲が広いことがわかるラベルにする', () => {
    expect(inferWorkload(principal('attribute.repository_owner/org'), provider()).label).toBe('GitHub org/*');
    expect(inferWorkload(principal('*'), provider()).label).toBe('GitHub 全リポジトリ');
    expect(
      inferWorkload(principal('*'), provider({ attributeCondition: `assertion.repository_owner_id == '123'` })).label,
    ).toBe('GitHub owner_id:123/*');
  });

  it('principal の値と attributeCondition が矛盾する場合は unreachable にする', () => {
    const workload = inferWorkload(principal('attribute.repository/org/other'), provider({ attributeCondition: `attribute.repository == 'org/infra'` }));

    expect(workload.unreachable).toBe(true);
  });

  it('解釈できない mapping や condition がある場合は partial にし、原文を残す', () => {
    const workload = inferWorkload(
      principal('attribute.full/org/app'),
      provider({
        attributeMapping: { ...GITHUB_MAPPING, 'attribute.full': `assertion.repository_owner + '/' + assertion.repository` },
        attributeCondition: `attribute.actor == 'alice' && size(assertion.aud) > 0`,
      }),
    );

    expect(workload).toMatchObject({
      confidence: 'partial',
      unresolvedMappings: { 'attribute.full': `assertion.repository_owner + '/' + assertion.repository` },
      // size(...) > 0 は字句解析で失敗するため、condition 全体が unparsed になる
      unparsedConditions: [`attribute.actor == 'alice' && size(assertion.aud) > 0`],
    });
    expect(workload.constraints).toContainEqual({ claim: 'attribute.full', op: 'eq', values: ['org/app'], source: 'principal' });
  });

  it('推定に使っていない mapping が解釈できなくても exact のままにする', () => {
    const workload = inferWorkload(
      principal('attribute.repository/org/app'),
      provider({ attributeMapping: { ...GITHUB_MAPPING, 'attribute.unused': `assertion.a + assertion.b` } }),
    );

    expect(workload.confidence).toBe('exact');
  });
});

describe('inferWorkload（GitHub 以外）', () => {
  it('claim と値をそのままラベルにする', () => {
    const workload = inferWorkload(
      principal('attribute.team/platform'),
      provider({ issuerUri: 'https://gitlab.example.com', attributeMapping: { 'attribute.team': 'assertion.namespace_path' } }),
    );

    expect(workload).toMatchObject({ idp: 'unknown', label: 'namespace_path=platform' });
  });

  it('追加の GitHub issuer（GHES）を指定できる', () => {
    const ghes = provider({ issuerUri: 'https://github.example.com/_services/token' });

    expect(inferWorkload(principal('attribute.repository/org/app'), ghes).idp).toBe('unknown');
    expect(inferWorkload(principal('attribute.repository/org/app'), ghes, { githubIssuers: ['https://github.example.com/_services/token'] }).idp).toBe('github');
  });
});

describe('parseGitHubSubject', () => {
  it('カスタマイズされた sub も key:value の組として分解する', () => {
    expect(parseGitHubSubject('repository_owner_id:123:repository_id:456:environment:prod')).toEqual({
      repository_owner_id: '123',
      repository_id: '456',
      environment: 'prod',
    });
  });
});

describe('inferWorkloads', () => {
  it('principal と同じ pool の provider だけを使う', () => {
    const other = provider({ name: 'projects/1/locations/global/workloadIdentityPools/other/providers/x', poolName: 'projects/1/locations/global/workloadIdentityPools/other' });

    expect(inferWorkloads(principal('attribute.repository/org/app'), [provider(), other]).map((w) => w.provider)).toEqual([provider().name]);
  });

  it('グラフ構築時に workload ノードと RESOLVES_TO エッジを作る', async () => {
    const explored = await explore(
      [REPO_PRINCIPAL],
      createStaticSource(source([{ resource: saResource('deploy'), role: 'roles/iam.workloadIdentityUser', member: REPO_PRINCIPAL }])),
      { maxDepth: 5 },
    );
    const graph = buildAccessGraph({ pools: [], providers: [provider()], containers, explored });
    const resolves = [...graph.edges.values()].filter((e) => e.kind === 'RESOLVES_TO');

    expect(resolves).toHaveLength(1);
    expect(resolves[0]).toMatchObject({ to: REPO_PRINCIPAL, provider: provider().name });
    expect(graph.nodes.get(resolves[0]!.from)).toMatchObject({ kind: 'workload', workload: { label: 'GitHub org/repo' } });
  });
});
