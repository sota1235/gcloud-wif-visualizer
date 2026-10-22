import { describe, expect, it } from 'vitest';
import { ResourceInventory, SNAPSHOT_SCHEMA_VERSION, type Container, type Snapshot } from '@wif-viz/core';
import { createSnapshotApi, type ResourcePage } from '../snapshot-api.ts';

const ORG = '//cloudresourcemanager.googleapis.com/organizations/1';
const PROJECT = '//cloudresourcemanager.googleapis.com/projects/proj';
const BUCKET = 'storage.googleapis.com/Bucket';
const containers: Container[] = [
  { name: ORG, type: 'organization', id: '1' },
  { name: PROJECT, type: 'project', id: 'proj', projectNumber: '111', parent: ORG },
];

const snapshot: Snapshot = {
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  collectedAt: '2026-10-20T00:00:00.000Z',
  org: { id: '1' },
  options: { maxDepth: 5 },
  roles: {},
  nodes: [],
  edges: [],
  effectiveAccess: [],
  resourceCounts: {},
  targetResources: {},
};

function api() {
  const names = ['c', 'a', 'b'].map((n) => `//storage.googleapis.com/${n}`);
  const inventory = new ResourceInventory(
    containers,
    names.map((name) => ({ name, assetType: BUCKET, ancestors: ['projects/111', 'organizations/1'] })),
  );
  return createSnapshotApi({ snapshot, inventory });
}

const page = (body: string) => JSON.parse(body) as ResourcePage;

describe('createSnapshotApi', () => {
  it('/api/snapshot はインベントリを除いたスナップショットを返す', () => {
    const res = api()('/api/snapshot', new URLSearchParams());

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(snapshot);
  });

  it('/api/resources は container 配下のリソースを名前順に、offset と limit で区切って返す', () => {
    const res = api()('/api/resources', new URLSearchParams({ container: ORG, assetType: BUCKET, offset: '1', limit: '1' }));

    expect(res.status).toBe(200);
    expect(page(res.body)).toEqual({ total: 3, offset: 1, items: ['//storage.googleapis.com/b'] });
  });

  it('offset と limit を省略した場合は先頭から返す', () => {
    const res = api()('/api/resources', new URLSearchParams({ container: PROJECT, assetType: BUCKET }));

    expect(page(res.body).items).toHaveLength(3);
  });

  it('該当するリソースがない場合は 0 件を返す', () => {
    const res = api()('/api/resources', new URLSearchParams({ container: PROJECT, assetType: 'run.googleapis.com/Service' }));

    expect(page(res.body)).toEqual({ total: 0, offset: 0, items: [] });
  });

  it('container や assetType がない場合、offset が不正な場合は 400 を返す', () => {
    expect(api()('/api/resources', new URLSearchParams({ assetType: BUCKET })).status).toBe(400);
    expect(api()('/api/resources', new URLSearchParams({ container: ORG, assetType: BUCKET, offset: '-1' })).status).toBe(400);
  });

  it('不明なパスは 404 を返す', () => {
    expect(api()('/api/unknown', new URLSearchParams()).status).toBe(404);
  });
});
