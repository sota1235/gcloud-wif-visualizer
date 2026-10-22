import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { ResourceInventory } from '../inventory.ts';
import { parseSnapshot } from '../snapshot.ts';
import type { Container, InventoryResource, Snapshot } from '../types.ts';

/** 書き出すときに、行をまとめて書き込む単位 */
const CHUNK_SIZE = 1 << 20;

export function containersOf(snapshot: Snapshot): Container[] {
  return snapshot.nodes.flatMap((n) => (n.kind === 'container' ? [n.container] : []));
}

/**
 * スナップショットを gzip 圧縮した JSON Lines で書き出す。
 * 1 行目がスナップショット（インベントリ以外）、2 行目以降がインベントリの 1 件ずつ。
 * ファイル全体を 1 つの文字列にしないため、大規模な Org でも書き出せる。
 */
export async function writeSnapshotFile(path: string, snapshot: Snapshot, inventory: Iterable<InventoryResource>): Promise<void> {
  async function* lines() {
    yield `${JSON.stringify({ type: 'snapshot', ...snapshot })}\n`;
    let chunk = '';
    for (const resource of inventory) {
      chunk += `${JSON.stringify({ type: 'resource', ...resource })}\n`;
      if (chunk.length >= CHUNK_SIZE) {
        yield chunk;
        chunk = '';
      }
    }
    if (chunk) yield chunk;
  }
  await pipeline(Readable.from(lines()), createGzip(), createWriteStream(path));
}

export interface ReadSnapshotOptions {
  /** false の場合は 1 行目だけを読む（インベントリを読まない） */
  inventory?: boolean;
}

export interface SnapshotFile {
  snapshot: Snapshot;
  /** inventory: false の場合は空 */
  inventory: ResourceInventory;
}

export async function readSnapshotFile(path: string, options: ReadSnapshotOptions = {}): Promise<SnapshotFile> {
  const stream = createReadStream(path);
  const lines = createInterface({ input: stream.pipe(createGunzip()), crlfDelay: Infinity });
  let snapshot: Snapshot | undefined;
  let inventory: ResourceInventory | undefined;
  try {
    for await (const line of lines) {
      if (!snapshot) {
        const { type, ...rest } = JSON.parse(line) as { type?: string };
        if (type !== 'snapshot') throw new Error('1 行目がスナップショットではありません');
        snapshot = parseSnapshot(JSON.stringify(rest));
        inventory = new ResourceInventory(containersOf(snapshot));
        if (options.inventory === false) break;
        continue;
      }
      if (!line) continue;
      const { type, name, assetType, ancestors } = JSON.parse(line) as { type?: string } & InventoryResource;
      if (type !== 'resource') throw new Error(`不明な行です（type: ${String(type)}）`);
      inventory!.add({ name, assetType, ancestors });
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'Z_DATA_ERROR') throw new Error(`${path} は gzip 圧縮された JSON Lines ではありません（schemaVersion 1 以前のスナップショットは読み込めません）`);
    throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!snapshot || !inventory) throw new Error(`${path} にスナップショットがありません`);
  return { snapshot, inventory };
}
