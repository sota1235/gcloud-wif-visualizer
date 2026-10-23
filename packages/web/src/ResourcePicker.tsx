import { useEffect, useState } from 'react';
import type { ResourceMatch } from '@wif-viz/core';
import type { ResourceSearchResult } from '../snapshot-api.ts';
import { useDebouncedValue } from './use-debounced-value.ts';
import { shortAssetType, shortResource } from './view-graph.ts';

/** 入力が止まってからサーバーに問い合わせるまでの時間 */
const SEARCH_DELAY_MS = 450;
const SEARCH_LIMIT = 20;

interface Props {
  selected: ResourceMatch | null;
  onSelect: (resource: ResourceMatch | null) => void;
}

/** リソース名で検索して 1 つ選ぶ（インベントリはサーバーにあるため API で探す） */
export function ResourcePicker({ selected, onSelect }: Props) {
  const [input, setInput] = useState('');
  const query = useDebouncedValue(input.trim(), SEARCH_DELAY_MS);
  const [result, setResult] = useState<ResourceSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
    if (query === '') return;
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/resource-search?${new URLSearchParams({ q: query, limit: String(SEARCH_LIMIT) })}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`リソースを検索できませんでした（${res.status}）`);
        setResult((await res.json()) as ResourceSearchResult);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query]);

  if (selected) {
    return (
      <div className="resource-picker">
        <span className="muted">リソースで絞り込む</span>
        <div className="resource-chip">
          <span>
            <code>{shortResource(selected.name)}</code>
            <span className="muted">（{shortAssetType(selected.assetType)}）</span>
          </span>
          <button type="button" className="link" onClick={() => onSelect(null)} aria-label="リソースの指定を解除">
            解除
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="resource-picker">
      <label className="search-field">
        <span>リソースで絞り込む</span>
        <input type="search" value={input} placeholder="例: バケット名、データセット名" autoComplete="off" onChange={(e) => setInput(e.target.value)} />
      </label>
      {input.trim() !== '' && (
        <div className="resource-candidates">
          {error ? (
            <p className="hint error">{error}</p>
          ) : loading || input.trim() !== query ? (
            <p className="hint muted">検索しています…</p>
          ) : result && result.items.length === 0 ? (
            <p className="hint muted">一致するリソースはありません（インベントリにあるアセットタイプのリソースが対象です）</p>
          ) : (
            result && (
              <>
                <p className="hint muted">
                  {result.total > result.items.length ? `${result.total} 件中、名前の短い ${result.items.length} 件を表示しています` : `${result.total} 件`}
                </p>
                <ul>
                  {result.items.map((r) => (
                    <li key={r.name}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(r);
                          setInput('');
                        }}
                      >
                        <code>{shortResource(r.name)}</code>
                        <span className="muted">{shortAssetType(r.assetType)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}
