import { describe, expect, it } from 'vitest';
import { SNAPSHOT_SCHEMA_VERSION, type Container, type EffectiveAccess, type Snapshot } from '@wif-viz/core';
import { buildViewGraph, grantNodeId } from '../src/view-graph.ts';

const ORG = '//cloudresourcemanager.googleapis.com/organizations/1';
const PROJECT = '//cloudresourcemanager.googleapis.com/projects/proj';
const BUCKET = 'storage.googleapis.com/Bucket';
const SECRET = 'secretmanager.googleapis.com/Secret';
const PRINCIPAL = 'principalSet://iam.googleapis.com/projects/111/locations/global/workloadIdentityPools/github/attribute.repository/org/app';
const SA = 'serviceAccount:deploy@proj.iam.gserviceaccount.com';
const project: Container = { name: PROJECT, type: 'project', id: 'proj', projectNumber: '111', parent: ORG };

const row = (role: string, assetTypes: string[]): EffectiveAccess => ({
  id: `ACCESS|${role}`,
  principal: PRINCIPAL,
  path: [PRINCIPAL, SA],
  role,
  grantedOn: PROJECT,
  grantedOnKind: 'container',
  assetTypes,
  unmappedPermissionCount: 0,
  conditional: false,
});

const snapshot = (effectiveAccess: EffectiveAccess[]): Snapshot => ({
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  collectedAt: '2026-10-20T00:00:00.000Z',
  org: { id: '1' },
  options: { maxDepth: 5 },
  roles: {},
  nodes: [
    { kind: 'container', id: PROJECT, container: project },
    { kind: 'serviceAccount', id: SA, email: 'deploy@proj.iam.gserviceaccount.com' },
  ],
  edges: effectiveAccess.map((r) => ({ id: `HAS_ROLE|${r.role}`, kind: 'HAS_ROLE', from: SA, to: PROJECT, role: r.role, resource: PROJECT })),
  effectiveAccess,
  resourceCounts: { [PROJECT]: { [BUCKET]: 120 } },
  targetResources: {},
});

describe('buildViewGraph', () => {
  it('container への付与を、identity × 付与箇所 × アセットタイプのまとまりにし、件数の表から件数を付ける', () => {
    const view = buildViewGraph(snapshot([row('roles/storage.admin', [BUCKET]), row('roles/storage.objectViewer', [BUCKET])]));
    const group = view.nodes.get(`rg|${SA}|${PROJECT}|${BUCKET}`);

    expect(group).toMatchObject({
      type: 'resourceGroup',
      label: 'Bucket ×120',
      assetType: BUCKET,
      resourceCount: 120,
      roles: ['roles/storage.admin', 'roles/storage.objectViewer'],
    });
    expect(view.edges).toContainEqual(expect.objectContaining({ source: grantNodeId(SA, PROJECT), target: group?.id, kind: 'resources' }));
  });

  it('配下にリソースがないアセットタイプのまとまりは作らない', () => {
    const view = buildViewGraph(snapshot([row('roles/secretmanager.admin', [SECRET])]));

    expect([...view.nodes.values()].filter((n) => n.type === 'resourceGroup')).toEqual([]);
  });
});
