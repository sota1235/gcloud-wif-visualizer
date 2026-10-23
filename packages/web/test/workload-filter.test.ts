import { describe, expect, it } from 'vitest';
import type { EffectiveAccess, ResourceMatch, Workload } from '@wif-viz/core';
import type { ViewGraph, ViewNode } from '../src/view-graph.ts';
import { filterWorkloads, workloadsReachingResource } from '../src/workload-filter.ts';

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

describe('workloadsReachingResource', () => {
  const ORG = '//cloudresourcemanager.googleapis.com/organizations/1';
  const PROJECT = '//cloudresourcemanager.googleapis.com/projects/proj';
  const OTHER_PROJECT = '//cloudresourcemanager.googleapis.com/projects/other';
  const BUCKET = 'storage.googleapis.com/Bucket';
  const bucket: ResourceMatch = { name: '//storage.googleapis.com/bucket-a', assetType: BUCKET, ancestors: [PROJECT, ORG] };

  const principalOf = (node: ViewNode) => (node.source?.kind === 'workload' ? node.source.workload.principal : '');
  const row = (workload: ViewNode, grantedOn: string, grantedOnKind: EffectiveAccess['grantedOnKind'], assetTypes: string[]): EffectiveAccess => ({
    id: `${principalOf(workload)}|${grantedOn}`,
    principal: principalOf(workload),
    path: [principalOf(workload)],
    role: 'roles/storage.admin',
    grantedOn,
    grantedOnKind,
    assetTypes,
    conditional: false,
    unmappedPermissionCount: 0,
  });
  const view: ViewGraph = {
    nodes: new Map(workloads.map((w) => [w.id, w])),
    edges: workloads.map((w) => ({ id: `resolves|${w.id}`, source: w.id, target: principalOf(w), kind: 'resolves' })),
  };

  it('祖先の container への付与のうち、リソースのアセットタイプに届くものから到達できるワークロードを返す', () => {
    const effectiveAccess = [row(app, PROJECT, 'container', [BUCKET]), row(web, ORG, 'container', ['secretmanager.googleapis.com/Secret'])];

    expect(workloadsReachingResource({ effectiveAccess }, view, bucket)).toEqual(new Set([app.id]));
  });

  it('リソースそのものへの付与から到達できるワークロードを返し、別の container への付与は含めない', () => {
    const effectiveAccess = [row(web, bucket.name, 'resource', [BUCKET]), row(app, OTHER_PROJECT, 'container', [BUCKET])];

    expect(workloadsReachingResource({ effectiveAccess }, view, bucket)).toEqual(new Set([web.id]));
  });
});
