import { describe, expect, it } from 'vitest';
import { ResourceInventory } from '../src/inventory.ts';
import { createResourceCounter } from '../src/resource-count.ts';
import type { AccessTarget, GraphNode } from '../src/types.ts';
import { containers, FOLDER, inventoryResource, ORG, PROJECT_A, PROJECT_B } from './fixtures.ts';

const BUCKET = 'storage.googleapis.com/Bucket';
const SECRET = 'secretmanager.googleapis.com/Secret';
const B1 = '//storage.googleapis.com/b1';
const B3 = '//storage.googleapis.com/b3';

function counter() {
  const inventory = new ResourceInventory(containers, [
    inventoryResource(B1, BUCKET),
    inventoryResource('//storage.googleapis.com/b2', BUCKET),
    inventoryResource(B3, BUCKET, 'b'),
    inventoryResource('//secretmanager.googleapis.com/projects/111/secrets/s', SECRET),
  ]);
  const nodes: GraphNode[] = containers.map((container) => ({ kind: 'container', id: container.name, container }));
  return createResourceCounter({
    nodes,
    resourceCounts: inventory.resourceCounts(),
    targetResources: { [B1]: inventory.targetResource(B1)!, [B3]: inventory.targetResource(B3)! },
  });
}

const onContainer = (grantedOn: string, ...assetTypes: string[]): AccessTarget => ({ grantedOn, grantedOnKind: 'container', assetTypes });
const onResource = (grantedOn: string, ...assetTypes: string[]): AccessTarget => ({ grantedOn, grantedOnKind: 'resource', assetTypes });

describe('createResourceCounter', () => {
  it('container への付与は、配下の該当アセットタイプのリソース数を数える', () => {
    expect(counter()([onContainer(PROJECT_A, BUCKET)])).toBe(2);
    expect(counter()([onContainer(PROJECT_A, BUCKET, SECRET)])).toBe(3);
  });

  it('祖先と子孫の container の両方に付与がある場合、重複して数えない', () => {
    expect(counter()([onContainer(PROJECT_A, BUCKET), onContainer(FOLDER, BUCKET), onContainer(ORG, BUCKET)])).toBe(3);
  });

  it('祖先・子孫の関係にない container の件数は足し合わせる', () => {
    expect(counter()([onContainer(PROJECT_A, BUCKET), onContainer(PROJECT_B, BUCKET)])).toBe(3);
  });

  it('アセットタイプが異なる付与は、祖先の container にあっても重複とみなさない', () => {
    expect(counter()([onContainer(ORG, SECRET), onContainer(PROJECT_B, BUCKET)])).toBe(2);
  });

  it('リソースへの付与は、同じアセットタイプで祖先の container に付与がなければ 1 件として数える', () => {
    expect(counter()([onResource(B3, BUCKET), onResource(B3, BUCKET)])).toBe(1);
    expect(counter()([onResource(B3, BUCKET), onContainer(PROJECT_B, BUCKET)])).toBe(1);
    expect(counter()([onResource(B1, BUCKET), onContainer(PROJECT_B, BUCKET)])).toBe(2);
  });

  it('インベントリにないリソースへの付与も 1 件として数える', () => {
    expect(counter()([onResource('//storage.googleapis.com/unknown'), onContainer(ORG, BUCKET)])).toBe(4);
  });

  it('assetTypeFilter で数えるアセットタイプを絞る', () => {
    expect(counter()([onContainer(PROJECT_A, BUCKET, SECRET), onResource(B3, BUCKET)], (t) => t === SECRET)).toBe(1);
  });

  it('件数の表にない container は 0 件として扱う', () => {
    expect(counter()([onContainer('//cloudresourcemanager.googleapis.com/projects/external', BUCKET)])).toBe(0);
  });
});
