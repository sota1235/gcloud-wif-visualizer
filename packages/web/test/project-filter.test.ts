import { describe, expect, it } from 'vitest';
import type { Container, EffectiveAccess, Finding, GraphNode, Snapshot } from '@wif-viz/core';
import { candidateProjects, filterFindingsByProjects, principalsForProjects, projectsOf } from '../src/project-filter.ts';

const CRM = '//cloudresourcemanager.googleapis.com';
const org: Container = { name: `${CRM}/organizations/1`, type: 'organization', id: '1' };
const folder: Container = { name: `${CRM}/folders/2`, type: 'folder', id: '2', parent: org.name };
const app: Container = { name: `${CRM}/projects/app`, type: 'project', id: 'app', projectNumber: '111', parent: folder.name };
const wif: Container = { name: `${CRM}/projects/wif`, type: 'project', id: 'wif', projectNumber: '222', parent: org.name };
const other: Container = { name: `${CRM}/projects/other`, type: 'project', id: 'other', projectNumber: '333', parent: org.name };

const POOL = 'projects/222/locations/global/workloadIdentityPools/github';
const principal = (repo: string) => `principalSet://iam.googleapis.com/${POOL}/attribute.repository/${repo}`;
const OUTSIDE = 'principalSet://iam.googleapis.com/projects/999/locations/global/workloadIdentityPools/x/*';

const principalNode = (id: string, projectNumber: string): GraphNode => ({
  kind: 'principal',
  id,
  principalKind: 'attribute',
  projectNumber,
  poolId: 'github',
  poolName: POOL,
});

const row = (p: string, grantedOn: string, grantedOnKind: EffectiveAccess['grantedOnKind']): EffectiveAccess => ({
  id: `${p}|${grantedOn}`,
  principal: p,
  path: [p],
  role: 'roles/viewer',
  grantedOn,
  grantedOnKind,
  assetTypes: [],
  unmappedPermissionCount: 0,
  conditional: false,
});

function snapshotOf(effectiveAccess: EffectiveAccess[], targetResources: Snapshot['targetResources'] = {}) {
  const nodes: GraphNode[] = [
    ...[other, app, org, wif, folder].map((container): GraphNode => ({ kind: 'container', id: container.name, container })),
    principalNode(principal('org/app'), '222'),
    principalNode(principal('org/web'), '222'),
    principalNode(OUTSIDE, '999'),
  ];
  return { nodes, effectiveAccess, targetResources };
}

describe('projectsOf', () => {
  it('container のうち project だけを ID の順に返す', () => {
    expect(projectsOf(snapshotOf([])).map((p) => p.id)).toEqual(['app', 'other', 'wif']);
  });
});

describe('principalsForProjects', () => {
  it('reach の場合、project への付与と祖先の folder への付与で届く principal を返す', () => {
    const snapshot = snapshotOf([row(principal('org/app'), app.name, 'container'), row(principal('org/web'), folder.name, 'container'), row(OUTSIDE, other.name, 'container')]);
    expect(principalsForProjects(snapshot, { projects: [app], mode: 'reach' })).toEqual(new Set([principal('org/app'), principal('org/web')]));
  });

  it('reach の場合、配下のリソースへの付与で届く principal も返す', () => {
    const bucket = '//storage.googleapis.com/bucket-a';
    const sa = '//iam.googleapis.com/projects/app/serviceAccounts/deploy@app.iam.gserviceaccount.com';
    const snapshot = snapshotOf(
      [row(principal('org/app'), bucket, 'resource'), row(principal('org/web'), sa, 'resource')],
      { [bucket]: { assetType: 'storage.googleapis.com/Bucket', ancestors: [app.name, folder.name, org.name] } },
    );
    expect(principalsForProjects(snapshot, { projects: [app], mode: 'reach' })).toEqual(new Set([principal('org/app'), principal('org/web')]));
    expect(principalsForProjects(snapshot, { projects: [other], mode: 'reach' })).toEqual(new Set());
  });

  it('pool の場合、その project の Pool の principal を返す', () => {
    expect(principalsForProjects(snapshotOf([]), { projects: [wif], mode: 'pool' })).toEqual(new Set([principal('org/app'), principal('org/web')]));
    expect(principalsForProjects(snapshotOf([]), { projects: [app], mode: 'pool' })).toEqual(new Set());
  });
});

describe('principalsForProjects（複数の project）', () => {
  it('reach の場合、選んだ project のいずれかに届く principal を返す', () => {
    const snapshot = snapshotOf([row(principal('org/app'), app.name, 'container'), row(OUTSIDE, other.name, 'container'), row(principal('org/web'), wif.name, 'container')]);
    expect(principalsForProjects(snapshot, { projects: [app, other], mode: 'reach' })).toEqual(new Set([principal('org/app'), OUTSIDE]));
  });

  it('project を 1 つも選んでいない場合、どの principal も返さない', () => {
    const snapshot = snapshotOf([row(principal('org/app'), org.name, 'container')]);
    expect(principalsForProjects(snapshot, { projects: [], mode: 'reach' })).toEqual(new Set());
    expect(principalsForProjects(snapshot, { projects: [], mode: 'pool' })).toEqual(new Set());
  });
});

describe('candidateProjects', () => {
  it('reach の場合、祖先への付与やリソースへの付与で権限が届く project を返す', () => {
    const snapshot = snapshotOf([
      row(principal('org/app'), folder.name, 'container'),
      row(principal('org/web'), '//iam.googleapis.com/projects/wif/serviceAccounts/x@wif.iam.gserviceaccount.com', 'resource'),
    ]);
    expect(candidateProjects(snapshot, 'reach').map((p) => p.id)).toEqual(['app', 'wif']);
  });

  it('pool の場合、Pool がある project を返す', () => {
    expect(candidateProjects(snapshotOf([]), 'pool').map((p) => p.id)).toEqual(['wif']);
  });
});

describe('filterFindingsByProjects', () => {
  const finding = (id: string, principals: string[], cause: Finding['cause']): Finding => ({
    id,
    ruleId: 'primitive-role',
    severity: 'high',
    message: '',
    recommendation: '',
    cause,
    nodeIds: [],
    impact: { principals, workloads: [], resourceCount: 0 },
  });
  const appSa = 'serviceAccount:deploy@app.iam.gserviceaccount.com';
  const otherSa = 'serviceAccount:deploy@other.iam.gserviceaccount.com';
  const onApp = finding('on-app', [principal('org/app')], { kind: 'binding', ref: appSa, role: 'roles/owner', grantedOn: app.name });
  const onFolder = finding('on-folder', [principal('org/app')], { kind: 'binding', ref: appSa, role: 'roles/owner', grantedOn: folder.name });
  const onOther = finding('on-other', [principal('org/app')], { kind: 'binding', ref: otherSa, role: 'roles/owner', grantedOn: other.name });
  const chainViaApp = finding('chain', [principal('org/web')], { kind: 'path', ref: `${principal('org/web')}>${otherSa}>${appSa}` });
  const provider = finding('provider', [principal('org/web')], { kind: 'provider', ref: `${POOL}/providers/github` });
  const emptyProvider = finding('empty-provider', [], { kind: 'provider', ref: `${POOL}/providers/other` });
  const outside = finding('outside', [OUTSIDE], { kind: 'pool', ref: 'projects/999/locations/global/workloadIdentityPools/x' });
  const all = [onApp, onFolder, onOther, chainViaApp, provider, emptyProvider, outside];

  it('reach の場合、原因の付与先がその project か祖先のもの、経路上の SA がその project のものを返す', () => {
    // org/app は org 全体に届くとしても、別の project への付与（on-other）は含めない
    const principals = new Set([principal('org/app')]);
    expect(filterFindingsByProjects(snapshotOf([]), all, { projects: [app], mode: 'reach' }, principals).map((f) => f.id)).toEqual(['on-app', 'on-folder', 'chain']);
  });

  it('reach の場合、Provider などが原因の検出結果は、影響を受ける principal が届くかで判定する', () => {
    expect(filterFindingsByProjects(snapshotOf([]), all, { projects: [wif], mode: 'reach' }, new Set([principal('org/web')])).map((f) => f.id)).toEqual(['provider']);
  });

  it('pool の場合、影響を受ける principal がその project の Pool のものと、原因の Provider がその project にあるものを返す', () => {
    const principals = new Set([principal('org/app'), principal('org/web')]);
    expect(filterFindingsByProjects(snapshotOf([]), all, { projects: [wif], mode: 'pool' }, principals).map((f) => f.id)).toEqual([
      'on-app',
      'on-folder',
      'on-other',
      'chain',
      'provider',
      'empty-provider',
    ]);
  });

  it('reach の場合、選んだ project のいずれかに原因がある検出結果を返す', () => {
    expect(filterFindingsByProjects(snapshotOf([]), all, { projects: [app, other], mode: 'reach' }, new Set()).map((f) => f.id)).toEqual([
      'on-app',
      'on-folder',
      'on-other',
      'chain',
    ]);
  });
});
