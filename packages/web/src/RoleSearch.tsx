import { useState } from 'react';
import { matchesTerms, type RoleMatch, type SearchMode } from './role-search.ts';
import { shortAssetType, shortResource, shortServiceAccount, type ViewGraph } from './view-graph.ts';

interface Props {
  mode: SearchMode;
  onModeChange: (mode: SearchMode) => void;
  query: string;
  onQueryChange: (query: string) => void;
  /** 入力候補（WIF から到達できるロール / permission） */
  candidates: string[];
  matches: RoleMatch[];
  selectedRole: string | null;
  onSelectRole: (role: string | null) => void;
  view: ViewGraph;
}

const MODES: { mode: SearchMode; label: string; placeholder: string; unit: string }[] = [
  { mode: 'role', label: 'ロール', placeholder: '例: storage.admin、owner', unit: 'ロール' },
  { mode: 'permission', label: 'permission', placeholder: '例: storage.objects.delete、setIamPolicy', unit: 'permission' },
];

/** 入力候補として表示する上限（permission は 1 万件を超えることがあるため） */
const MAX_SUGGESTIONS = 50;

/** カードに一度に表示する一致 permission の数 */
const PERMISSION_PREVIEW = 3;

const identityLabel = (identity: string) =>
  identity.includes('workloadIdentityPools/') ? identity.replace(/^.*workloadIdentityPools\//, '') : shortServiceAccount(identity);

export function RoleSearch({ mode, onModeChange, query, onQueryChange, candidates, matches, selectedRole, onSelectRole, view }: Props) {
  const current = MODES.find((m) => m.mode === mode)!;
  const [showAllPermissions, setShowAllPermissions] = useState(false);
  const suggestions = (query.trim() === '' ? candidates : candidates.filter((c) => matchesTerms(c, query))).slice(0, MAX_SUGGESTIONS);

  return (
    <div className="role-search">
      <div className="segmented" role="radiogroup" aria-label="検索対象">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            role="radio"
            aria-checked={mode === m.mode}
            onClick={() => {
              onModeChange(m.mode);
              onSelectRole(null);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <label className="search-field">
        <span>{current.label}で検索</span>
        <input
          type="search"
          value={query}
          list="search-candidates"
          placeholder={current.placeholder}
          autoComplete="off"
          onChange={(e) => {
            onQueryChange(e.target.value);
            onSelectRole(null);
          }}
        />
        <datalist id="search-candidates">
          {suggestions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <p className="hint muted">
        {query.trim() === ''
          ? `WIF から到達できる${current.unit}は ${candidates.length} 種類です。空白区切りで複数の語を指定すると、すべてを含むものに絞り込みます。`
          : `${matches.length} 件のロールが一致しました。${selectedRole ? '' : 'グラフには一致したすべてのロールの経路を表示しています。'}`}
      </p>
      <ol>
        {matches.map((match) => {
          const selected = match.role === selectedRole;
          const permissions = match.matchedPermissions ?? [];
          const visiblePermissions = selected && showAllPermissions ? permissions : permissions.slice(0, PERMISSION_PREVIEW);
          return (
            <li key={match.role}>
              <button
                type="button"
                className={`role-match${selected ? ' selected' : ''}`}
                onClick={() => {
                  onSelectRole(selected ? null : match.role);
                  setShowAllPermissions(false);
                }}
              >
                <code className="role-name">{match.role}</code>
                {permissions.length > 0 && (
                  <span className="matched-permissions">
                    {visiblePermissions.map((p) => (
                      <code key={p}>{p}</code>
                    ))}
                    {visiblePermissions.length < permissions.length && <span className="muted">ほか {permissions.length - visiblePermissions.length} 件</span>}
                  </span>
                )}
                <span className="finding-impact">
                  Workload {match.workloads.length} / 付与 {match.grants.length} / リソース {match.resourceCount}
                  {match.assetTypes && match.assetTypes.length === 0 && '（リソース単位に展開できない permission）'}
                  {match.assetTypes && match.assetTypes.length > 0 && `（${match.assetTypes.map(shortAssetType).join(', ')}）`}
                </span>
                {selected && (
                  <span className="role-detail">
                    <span className="muted">Workload</span>
                    {match.workloads.map((id) => (
                      <span key={id}>{view.nodes.get(id)?.label ?? id}</span>
                    ))}
                    <span className="muted">付与</span>
                    {match.grants.map((g) => (
                      <code key={g.viewNodeId + g.identity} className="wrap">
                        {identityLabel(g.identity)} @ {shortResource(g.grantedOn)}
                      </code>
                    ))}
                  </span>
                )}
              </button>
              {selected && permissions.length > PERMISSION_PREVIEW && (
                <button type="button" className="link show-more" onClick={() => setShowAllPermissions((v) => !v)}>
                  {showAllPermissions ? '一致した permission を折りたたむ' : `一致した permission をすべて表示（${permissions.length} 件）`}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
