import { describe, expect, it } from 'vitest';
import { ResourceInventory } from '../src/inventory.ts';
import { containers, FOLDER, inventoryResource, ORG, PROJECT_A, PROJECT_B } from './fixtures.ts';

const BUCKET = 'storage.googleapis.com/Bucket';
const SECRET = 'secretmanager.googleapis.com/Secret';

const inventory = () =>
  new ResourceInventory(containers, [
    inventoryResource('//storage.googleapis.com/b2', BUCKET),
    inventoryResource('//storage.googleapis.com/b1', BUCKET),
    inventoryResource('//storage.googleapis.com/b3', BUCKET, 'b'),
    inventoryResource('//secretmanager.googleapis.com/projects/111/secrets/s', SECRET),
  ]);

describe('ResourceInventory', () => {
  it('container 配下のリソースを、子孫の container の分も含めて名前順に返す', () => {
    const inv = inventory();

    expect(inv.list(PROJECT_A, BUCKET)).toEqual(['//storage.googleapis.com/b1', '//storage.googleapis.com/b2']);
    expect(inv.list(FOLDER, BUCKET)).toEqual(['//storage.googleapis.com/b1', '//storage.googleapis.com/b2']);
    expect(inv.list(ORG, BUCKET)).toEqual(['//storage.googleapis.com/b1', '//storage.googleapis.com/b2', '//storage.googleapis.com/b3']);
    expect(inv.list(PROJECT_B, SECRET)).toEqual([]);
  });

  it('同じ名前のリソースは 1 件として扱う', () => {
    const inv = inventory();
    inv.add(inventoryResource('//storage.googleapis.com/b1', BUCKET));

    expect(inv.size).toBe(4);
    expect(inv.list(PROJECT_A, BUCKET)).toHaveLength(2);
  });

  it('実効アクセスの到達先を、付与先とアセットタイプから求める', () => {
    const inv = inventory();

    expect(inv.listTarget({ grantedOn: PROJECT_A, grantedOnKind: 'container', assetTypes: [SECRET, BUCKET] })).toEqual([
      '//secretmanager.googleapis.com/projects/111/secrets/s',
      '//storage.googleapis.com/b1',
      '//storage.googleapis.com/b2',
    ]);
    expect(inv.listTarget({ grantedOn: '//storage.googleapis.com/b3', grantedOnKind: 'resource', assetTypes: [BUCKET] })).toEqual([
      '//storage.googleapis.com/b3',
    ]);
  });

  it('container × アセットタイプごとの件数の表を作る', () => {
    expect(inventory().resourceCounts()).toEqual({
      [FOLDER]: { [SECRET]: 1, [BUCKET]: 2 },
      [ORG]: { [SECRET]: 1, [BUCKET]: 3 },
      [PROJECT_A]: { [SECRET]: 1, [BUCKET]: 2 },
      [PROJECT_B]: { [BUCKET]: 1 },
    });
  });

  it('リソースへの付与の付与先について、アセットタイプと祖先の container を返す', () => {
    expect(inventory().targetResource('//storage.googleapis.com/b3')).toEqual({ assetType: BUCKET, ancestors: [PROJECT_B, ORG] });
    expect(inventory().targetResource('//storage.googleapis.com/unknown')).toBeUndefined();
  });

  it('Org 外の container は祖先に含めない', () => {
    const inv = new ResourceInventory(containers, [{ name: '//storage.googleapis.com/x', assetType: BUCKET, ancestors: ['projects/999', 'organizations/2'] }]);

    expect(inv.targetResource('//storage.googleapis.com/x')).toEqual({ assetType: BUCKET, ancestors: [] });
    expect(inv.resourceCounts()).toEqual({});
  });
});
