import { useMemo, useState } from 'react';
import type { Container } from '@wif-viz/core';
import { matchesTerms } from './role-search.ts';
import type { ProjectFilterMode } from './project-filter.ts';

const MODE_LABELS: Record<ProjectFilterMode, string> = { reach: '権限が届く', pool: 'Pool がある' };
const MODE_HINTS: Record<ProjectFilterMode, string> = {
  reach: '選んだ project（または配下のリソース）のいずれかに WIF 経由で権限が届くもの。folder / org への付与で届くものを含みます',
  pool: '選んだ project のいずれかに定義された WIF Pool を使うもの',
};

interface Props {
  mode: ProjectFilterMode;
  onModeChange: (mode: ProjectFilterMode) => void;
  /** mode で 1 つ以上当てはまる project */
  candidates: Container[];
  /** 選択から外した project の full resource name（空ならすべて選択） */
  excluded: Set<string>;
  onExcludedChange: (excluded: Set<string>) => void;
  /** 絞り込んだ結果の件数の説明 */
  summary?: string;
}

const projectSearchText = (project: Container) => [project.id, project.displayName ?? ''].join('\n');

/** project を選び、権限が届くか / Pool があるかで絞り込む。最初はすべて選んだ状態で、1 つずつ外せる */
export function ProjectPicker({ mode, onModeChange, candidates, excluded, onExcludedChange, summary }: Props) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => (query.trim() === '' ? candidates : candidates.filter((p) => matchesTerms(projectSearchText(p), query))), [candidates, query]);
  const selectedCount = candidates.filter((p) => !excluded.has(p.name)).length;
  const filtering = selectedCount < candidates.length;

  const toggle = (project: Container) => {
    const next = new Set(excluded);
    if (next.has(project.name)) next.delete(project.name);
    else next.add(project.name);
    onExcludedChange(next);
  };
  const setVisible = (selected: boolean) => {
    const next = new Set(excluded);
    for (const p of visible) {
      if (selected) next.delete(p.name);
      else next.add(p.name);
    }
    onExcludedChange(next);
  };

  return (
    <div className="project-picker">
      <details>
        <summary>
          project で絞り込む
          <span className={filtering ? 'project-count active' : 'project-count muted'}>
            {filtering ? `${candidates.length} 件中 ${selectedCount} 件を選択` : `すべて（${candidates.length} 件）`}
          </span>
        </summary>
        <div className="mode-toggle" role="group" aria-label="project での絞り込み方">
          {(['reach', 'pool'] as const).map((m) => (
            <button key={m} type="button" className="chip" aria-pressed={mode === m} onClick={() => onModeChange(m)}>
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
        <p className="hint muted">{MODE_HINTS[mode]}</p>
        <div className="search-field">
          <input type="search" value={query} placeholder="project ID で探す" aria-label="project を探す" autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="project-actions">
          <button type="button" className="link" onClick={() => setVisible(true)}>
            {query.trim() === '' ? 'すべて選択' : '表示中をすべて選択'}
          </button>
          <button type="button" className="link" onClick={() => setVisible(false)}>
            {query.trim() === '' ? 'すべて外す' : '表示中をすべて外す'}
          </button>
        </div>
        <ul className="project-list">
          {visible.map((p) => (
            <li key={p.name}>
              <label>
                <input type="checkbox" checked={!excluded.has(p.name)} onChange={() => toggle(p)} />
                <span>
                  <code>{p.id}</code>
                  {p.displayName && p.displayName !== p.id && <span className="muted"> {p.displayName}</span>}
                </span>
              </label>
            </li>
          ))}
          {visible.length === 0 && <li className="muted">一致する project はありません</li>}
        </ul>
      </details>
      {filtering && summary && <p className="hint muted">{summary}</p>}
    </div>
  );
}
