import { describe, expect, it } from 'vitest';
import type { Workload } from '@wif-viz/core';
import type { ViewNode } from '../src/view-graph.ts';
import { filterWorkloads } from '../src/workload-filter.ts';

const POOL = 'projects/111/locations/global/workloadIdentityPools/github';

function workloadNode(label: string, repository: string, constraints: Workload['constraints'] = []): ViewNode {
  const principal = `principalSet://iam.googleapis.com/${POOL}/attribute.repository/${repository}`;
  const workload: Workload = {
    id: `workload|${principal}`,
    principal,
    provider: `${POOL}/providers/github`,
    idp: 'github',
    label,
    constraints,
    unparsedConditions: [],
    unresolvedMappings: {},
    unreachable: false,
    confidence: 'exact',
  };
  return { id: workload.id, type: 'workload', label, source: { kind: 'workload', id: workload.id, workload } };
}

const app = workloadNode('org/app', 'org/app', [{ claim: 'workflow_ref', op: 'eq', values: ['org/app/.github/workflows/deploy.yml@refs/heads/main'], source: 'condition' }]);
const web = workloadNode('org/web', 'org/web');
const workloads = [app, web];

describe('filterWorkloads', () => {
  it('検索語が空の場合、すべてのワークロードを返す', () => {
    expect(filterWorkloads(workloads, '  ')).toEqual(workloads);
  });

  it('ラベルに一致するワークロードに絞り込む', () => {
    expect(filterWorkloads(workloads, 'WEB')).toEqual([web]);
  });

  it('ラベルに出ていない claim の制約の値や Provider でも絞り込める', () => {
    expect(filterWorkloads(workloads, 'deploy.yml')).toEqual([app]);
    expect(filterWorkloads(workloads, 'providers/github')).toEqual(workloads);
  });

  it('空白区切りの語をすべて含むワークロードだけを返す', () => {
    expect(filterWorkloads(workloads, 'org deploy')).toEqual([app]);
    expect(filterWorkloads(workloads, 'web deploy')).toEqual([]);
  });
});
