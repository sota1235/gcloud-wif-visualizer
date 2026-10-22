import type { SnapshotFile } from '@wif-viz/core/node';

export interface ApiResponse {
  status: number;
  body: string;
}

export interface ResourcePage {
  total: number;
  offset: number;
  items: string[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const json = (status: number, value: unknown): ApiResponse => ({ status, body: JSON.stringify(value) });

function nonNegativeInteger(value: string | null, fallback: number): number | undefined {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Web UI 向けの API。
 * - `/api/snapshot`: インベントリを除いたスナップショット
 * - `/api/resources?container=&assetType=&offset=&limit=`: container 配下の、指定したアセットタイプのリソース（名前順）
 */
export function createSnapshotApi({ snapshot, inventory }: SnapshotFile) {
  const snapshotBody = JSON.stringify(snapshot);

  return (pathname: string, params: URLSearchParams): ApiResponse => {
    if (pathname === '/api/snapshot') return { status: 200, body: snapshotBody };
    if (pathname === '/api/resources') {
      const container = params.get('container');
      const assetType = params.get('assetType');
      const offset = nonNegativeInteger(params.get('offset'), 0);
      const limit = nonNegativeInteger(params.get('limit'), DEFAULT_LIMIT);
      if (!container || !assetType || offset === undefined || limit === undefined) {
        return json(400, { error: 'container と assetType は必須です。offset と limit は 0 以上の整数で指定してください' });
      }
      const all = inventory.list(container, assetType);
      const page: ResourcePage = { total: all.length, offset, items: all.slice(offset, offset + Math.min(limit, MAX_LIMIT)) };
      return json(200, page);
    }
    return json(404, { error: 'not found' });
  };
}
