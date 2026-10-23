import { useEffect, useState } from 'react';
import type { ResourcePage } from '../snapshot-api.ts';

const PAGE_SIZE = 100;

interface Props {
  container: string;
  assetType: string;
}

/** container 配下のリソースを、サーバーからページ単位で取得して表示する */
export function ResourceList({ container, assetType }: Props) {
  const [items, setItems] = useState<string[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (offset: number) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ container, assetType, offset: String(offset), limit: String(PAGE_SIZE) });
      const res = await fetch(`/api/resources?${params}`);
      if (!res.ok) throw new Error(`リソースを取得できませんでした（${res.status}）`);
      const page = (await res.json()) as ResourcePage;
      setItems((current) => (offset === 0 ? page.items : [...current, ...page.items]));
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setItems([]);
    setTotal(null);
    void load(0);
  }, [container, assetType]);

  return (
    <>
      <ul className="resource-list">
        {items.map((name) => (
          <li key={name}>
            <code className="wrap">{name}</code>
          </li>
        ))}
      </ul>
      {error && <p className="message error">{error}</p>}
      {total !== null && items.length < total && (
        <button type="button" className="link" disabled={loading} onClick={() => void load(items.length)}>
          さらに表示（{items.length} / {total} 件）
        </button>
      )}
      {loading && items.length === 0 && <span className="muted">読み込んでいます…</span>}
    </>
  );
}
