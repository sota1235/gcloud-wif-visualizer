import { useEffect, useMemo, useState } from 'react';
import { useDebouncedValue } from './use-debounced-value.ts';
import { filterWorkloads } from './workload-filter.ts';
import type { ViewNode } from './view-graph.ts';

/** 入力が止まってから絞り込むまでの時間 */
const FILTER_DELAY_MS = 450;

interface Props {
  workloads: ViewNode[];
  /** 絞り込みに使う検索語（入力が止まってから更新される） */
  query: string;
  onQueryChange: (query: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function WorkloadList({ workloads, query, onQueryChange, selectedId, onSelect }: Props) {
  // 入力中は画面全体を再描画しないよう、入力欄の値はここで持ち、止まってから親に渡す
  const [input, setInput] = useState(query);
  const debouncedInput = useDebouncedValue(input, FILTER_DELAY_MS);
  useEffect(() => {
    if (debouncedInput !== query) onQueryChange(debouncedInput);
  }, [debouncedInput, query, onQueryChange]);
  const filtered = useMemo(() => filterWorkloads(workloads, query), [workloads, query]);

  return (
    <div className="workloads">
      <label className="search-field">
        <span>ワークロードを絞り込む</span>
        <input type="search" value={input} placeholder="例: リポジトリ名、ブランチ、ワークフロー" autoComplete="off" onChange={(e) => setInput(e.target.value)} />
      </label>
      <p className="hint muted">
        {query.trim() === ''
          ? 'リポジトリ名やブランチ、principal などで絞り込めます。空白区切りで複数の語を指定すると、すべてを含むものに絞り込みます。'
          : `${workloads.length} 件中 ${filtered.length} 件が一致しました。`}
      </p>
      <ul className="workload-list">
        {filtered.map((w) => (
          <li key={w.id}>
            <button type="button" className={selectedId === w.id ? 'selected' : ''} onClick={() => onSelect(w.id)}>
              {w.severity && <span className={`severity-dot severity-${w.severity}`} />}
              {w.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
