import { useEffect, useMemo, useState } from 'react';
import { findingsOf, parseSnapshot, type Finding, type Severity, type Snapshot } from '@wif-viz/core';
import { DetailPanel } from './DetailPanel.tsx';
import { FindingList } from './FindingList.tsx';
import { focusSubgraph, overviewGraph, pathSubgraph } from './focus.ts';
import { GraphView } from './GraphView.tsx';
import { roleFocus, searchRoles } from './role-search.ts';
import { RoleSearch } from './RoleSearch.tsx';
import { buildViewGraph, findingFocus } from './view-graph.ts';

type Tab = 'findings' | 'workloads' | 'roles';

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('findings');
  const [severityFilter, setSeverityFilter] = useState<Set<Severity>>(new Set(['high', 'medium', 'low']));
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [focusIds, setFocusIds] = useState<string[] | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [roleQuery, setRoleQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/snapshot')
      .then(async (res) => {
        if (!res.ok) throw new Error(`スナップショットを読み込めませんでした（${res.status}）`);
        setSnapshot(parseSnapshot(await res.text()));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const findings = useMemo(() => (snapshot ? findingsOf(snapshot) : []), [snapshot]);
  const view = useMemo(() => (snapshot ? buildViewGraph(snapshot, findings) : null), [snapshot, findings]);
  const reachableRoles = useMemo(() => (snapshot ? [...new Set(snapshot.effectiveAccess.map((r) => r.role))].sort() : []), [snapshot]);
  const roleMatches = useMemo(() => (snapshot && view ? searchRoles(snapshot, view, roleQuery) : []), [snapshot, view, roleQuery]);
  const roleSearchActive = tab === 'roles' && !focusIds && roleMatches.length > 0;
  const focus = useMemo(() => {
    if (!view) return null;
    if (selectedFinding) return findingFocus(selectedFinding, view);
    if (roleSearchActive) return roleFocus(selectedRole ? roleMatches.filter((m) => m.role === selectedRole) : roleMatches, view);
    return null;
  }, [view, selectedFinding, roleSearchActive, roleMatches, selectedRole]);
  const displayed = useMemo(() => {
    if (!view) return null;
    if (focus) return pathSubgraph(view, focus.upstreamFrom, focus.downstreamFrom);
    return focusIds ? focusSubgraph(view, focusIds) : overviewGraph(view);
  }, [view, focus, focusIds]);
  const workloads = useMemo(() => (view ? [...view.nodes.values()].filter((n) => n.type === 'workload').sort((a, b) => a.label.localeCompare(b.label)) : []), [view]);

  if (error) return <p className="message error">{error}</p>;
  if (!snapshot || !view || !displayed) return <p className="message">読み込んでいます…</p>;

  const selectFinding = (finding: Finding) => {
    setSelectedFinding(finding);
    setFocusIds(null);
    setSelectedRole(null);
    setSelectedNodeId(null);
  };
  const focusOn = (id: string) => {
    setSelectedFinding(null);
    setFocusIds([id]);
    setSelectedNodeId(id);
  };
  const showOverview = () => {
    setSelectedFinding(null);
    setFocusIds(null);
    setSelectedNodeId(null);
    setRoleQuery('');
    setSelectedRole(null);
  };
  const switchTab = (next: Tab) => {
    setTab(next);
    // 別のタブの選択状態がグラフに残らないようにする
    setSelectedFinding(null);
    setFocusIds(null);
    setSelectedNodeId(null);
  };
  const highlightIds = focus ? focus.highlight : focusIds ?? [];
  const selectedNode = selectedNodeId ? view.nodes.get(selectedNodeId) : undefined;

  return (
    <div className="app">
      <header className="app-header">
        <h1>WIF Visualizer</h1>
        <span className="muted">
          {snapshot.org.displayName ?? snapshot.org.id} ・ {new Date(snapshot.collectedAt).toLocaleString('ja-JP')} 時点
        </span>
        <span className="spacer" />
        <button type="button" className="link" onClick={showOverview} disabled={!focusIds && !selectedFinding && !roleSearchActive}>
          概観に戻る
        </button>
      </header>

      <nav className="sidebar" aria-label="対応推奨リストとワークロード">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'findings'} onClick={() => switchTab('findings')}>
            対応推奨リスト（{findings.length}）
          </button>
          <button type="button" role="tab" aria-selected={tab === 'workloads'} onClick={() => switchTab('workloads')}>
            ワークロード（{workloads.length}）
          </button>
          <button type="button" role="tab" aria-selected={tab === 'roles'} onClick={() => switchTab('roles')}>
            ロール
          </button>
        </div>
        {tab === 'findings' ? (
          <FindingList
            findings={findings}
            selectedId={selectedFinding?.id ?? null}
            onSelect={selectFinding}
            severityFilter={severityFilter}
            onToggleSeverity={(severity) =>
              setSeverityFilter((current) => {
                const next = new Set(current);
                if (next.has(severity)) next.delete(severity);
                else next.add(severity);
                return next;
              })
            }
          />
        ) : tab === 'roles' ? (
          <RoleSearch
            query={roleQuery}
            onQueryChange={setRoleQuery}
            roles={reachableRoles}
            matches={roleMatches}
            selectedRole={selectedRole}
            onSelectRole={setSelectedRole}
            view={view}
          />
        ) : (
          <ul className="workload-list">
            {workloads.map((w) => (
              <li key={w.id}>
                <button type="button" className={focusIds?.[0] === w.id ? 'selected' : ''} onClick={() => focusOn(w.id)}>
                  {w.severity && <span className={`severity-dot severity-${w.severity}`} />}
                  {w.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <main className="graph">
        <div className="graph-caption">
          {selectedFinding
            ? `検出結果の経路: ${selectedFinding.ruleId}`
            : roleSearchActive
              ? `ロールの経路: ${selectedRole ?? `「${roleQuery.trim()}」に一致する ${roleMatches.length} ロール`}`
              : focusIds
                ? 'フォーカス表示'
                : '概観（Workload → principal → SA）'}
          <span className="muted"> ・ ノード {displayed.nodes.size}</span>
        </div>
        <GraphView graph={displayed} highlightIds={highlightIds} selectedId={selectedNodeId} onSelect={setSelectedNodeId} />
        {selectedNode && (
          <DetailPanel
            node={selectedNode}
            grants={[...view.nodes.values()].filter((n) => n.type === 'grant' && n.identity === selectedNode.id)}
            onFocus={focusOn}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </main>
    </div>
  );
}
