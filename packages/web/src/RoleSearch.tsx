import type { RoleMatch } from './role-search.ts';
import { shortResource, shortServiceAccount, type ViewGraph } from './view-graph.ts';

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
  /** 入力候補（WIF から到達できるロール） */
  roles: string[];
  matches: RoleMatch[];
  selectedRole: string | null;
  onSelectRole: (role: string | null) => void;
  view: ViewGraph;
}

const identityLabel = (identity: string) =>
  identity.includes('workloadIdentityPools/') ? identity.replace(/^.*workloadIdentityPools\//, '') : shortServiceAccount(identity);

export function RoleSearch({ query, onQueryChange, roles, matches, selectedRole, onSelectRole, view }: Props) {
  return (
    <div className="role-search">
      <label className="search-field">
        <span>ロール名で検索</span>
        <input
          type="search"
          value={query}
          list="role-candidates"
          placeholder="例: storage.admin、owner"
          autoComplete="off"
          onChange={(e) => {
            onQueryChange(e.target.value);
            onSelectRole(null);
          }}
        />
        <datalist id="role-candidates">
          {roles.map((role) => (
            <option key={role} value={role} />
          ))}
        </datalist>
      </label>
      <p className="hint muted">
        {query.trim() === ''
          ? `WIF から到達できるロールは ${roles.length} 種類です。空白区切りで複数の語を指定すると、すべてを含むロールに絞り込みます。`
          : `${matches.length} 件のロールが一致しました。${selectedRole ? '' : 'グラフには一致したすべてのロールの経路を表示しています。'}`}
      </p>
      <ol>
        {matches.map((match) => {
          const selected = match.role === selectedRole;
          return (
            <li key={match.role}>
              <button type="button" className={`role-match${selected ? ' selected' : ''}`} onClick={() => onSelectRole(selected ? null : match.role)}>
                <code className="role-name">{match.role}</code>
                <span className="finding-impact">
                  Workload {match.workloads.length} / 付与 {match.grants.length} / リソース {match.resourceCount}
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
            </li>
          );
        })}
      </ol>
    </div>
  );
}
