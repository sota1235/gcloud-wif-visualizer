import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { findingsOf, parseSnapshot, type Finding, type ResourceMatch, type Severity, type Snapshot } from '@wif-viz/core';
import { DetailPanel } from './DetailPanel.tsx';
import { FindingList } from './FindingList.tsx';
import { downstreamSubgraph, focusSubgraph, overviewGraph, pathSubgraph } from './focus.ts';
import { GraphView } from './GraphView.tsx';
import { narrowToWorkload, reachableRolesAndPermissions, roleFocus, searchAccess, type SearchMode } from './role-search.ts';
import { RoleSearch } from './RoleSearch.tsx';
import { SidebarResizer, useSidebarWidth } from './SidebarResizer.tsx';
import { buildViewGraph, findingFocus, type ViewGraph } from './view-graph.ts';
import { workloadsReachingResource } from './workload-filter.ts';
import { WorkloadList } from './WorkloadList.tsx';

type Tab = 'findings' | 'workloads' | 'roles';

/** これを超えるノード数のグラフは、目で追えず描画も重いため、既定では表示しない */
const MAX_GRAPH_NODES = 500;

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('findings');
  const [severityFilter, setSeverityFilter] = useState<Set<Severity>>(new Set(['high', 'medium', 'low']));
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [focusIds, setFocusIds] = useState<string[] | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [searchMode, setSearchMode] = useState<SearchMode>('role');
  const [roleQuery, setRoleQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [workloadQuery, setWorkloadQuery] = useState('');
  const [workloadResource, setWorkloadResource] = useState<ResourceMatch | null>(null);
  // 検索結果のロールを選んだうえで、さらに 1 つのワークロードに絞る
  const [searchWorkload, setSearchWorkload] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  // ノード数が多くても表示するよう選んだグラフ。表示するグラフが変わると、また非表示に戻る
  const [largeGraphShown, setLargeGraphShown] = useState<ViewGraph | null>(null);

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
  const reachable = useMemo(() => (snapshot ? reachableRolesAndPermissions(snapshot) : { roles: [], permissions: [] }), [snapshot]);
  const roleMatches = useMemo(
    () => (snapshot && view ? searchAccess(snapshot, view, roleQuery, searchMode) : []),
    [snapshot, view, roleQuery, searchMode],
  );
  const roleSearchActive = tab === 'roles' && !focusIds && roleMatches.length > 0;
  const searchWorkloadActive = roleSearchActive && selectedRole !== null && searchWorkload !== null;
  const focus = useMemo(() => {
    if (!view) return null;
    if (selectedFinding) return findingFocus(selectedFinding, view);
    if (roleSearchActive) {
      const selected = selectedRole ? roleMatches.filter((m) => m.role === selectedRole) : roleMatches;
      if (!searchWorkloadActive) return roleFocus(selected, view);
      const narrowed = roleFocus(narrowToWorkload(selected, view, searchWorkload!), view);
      return { ...narrowed, highlight: [searchWorkload!, ...narrowed.highlight] };
    }
    return null;
  }, [view, selectedFinding, roleSearchActive, roleMatches, selectedRole, searchWorkloadActive, searchWorkload]);
  const displayed = useMemo(() => {
    if (!view) return null;
    if (focus) {
      const paths = pathSubgraph(view, focus.upstreamFrom, focus.downstreamFrom);
      return searchWorkloadActive ? downstreamSubgraph(paths, searchWorkload!) : paths;
    }
    return focusIds ? focusSubgraph(view, focusIds) : overviewGraph(view);
  }, [view, focus, focusIds, searchWorkloadActive, searchWorkload]);
  const reachingIds = useMemo(
    () => (snapshot && view && workloadResource ? workloadsReachingResource(snapshot, view, workloadResource) : null),
    [snapshot, view, workloadResource],
  );
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
    setSearchWorkload(null);
  };
  const switchTab = (next: Tab) => {
    setTab(next);
    // 別のタブの選択状態がグラフに残らないようにする
    setSelectedFinding(null);
    setFocusIds(null);
    setSelectedNodeId(null);
  };
  const highlightIds = focus ? focus.highlight : focusIds ?? [];
  const graphHidden = displayed.nodes.size > MAX_GRAPH_NODES && largeGraphShown !== displayed;
  const selectedNode = selectedNodeId ? view.nodes.get(selectedNodeId) : undefined;

  return (
    <div className="app" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
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
            検索
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
            mode={searchMode}
            onModeChange={setSearchMode}
            query={roleQuery}
            onQueryChange={(query) => {
              setRoleQuery(query);
              setSearchWorkload(null);
            }}
            candidates={searchMode === 'role' ? reachable.roles : reachable.permissions}
            matches={roleMatches}
            selectedRole={selectedRole}
            onSelectRole={(role) => {
              setSelectedRole(role);
              setSearchWorkload(null);
            }}
            selectedWorkload={searchWorkload}
            onSelectWorkload={setSearchWorkload}
            view={view}
          />
        ) : (
          <WorkloadList
            workloads={workloads}
            query={workloadQuery}
            onQueryChange={setWorkloadQuery}
            selectedId={focusIds?.[0] ?? null}
            onSelect={focusOn}
            resource={workloadResource}
            onResourceChange={setWorkloadResource}
            reachingIds={reachingIds}
          />
        )}
      </nav>
      <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />

      <main className="graph">
        <div className="graph-caption">
          {selectedFinding
            ? `検出結果の経路: ${selectedFinding.ruleId}`
            : roleSearchActive
              ? `${searchMode === 'role' ? 'ロール' : 'permission'}の経路: ${selectedRole ?? `「${roleQuery.trim()}」に一致する ${roleMatches.length} ロール`}${
                  searchWorkloadActive ? `（${view.nodes.get(searchWorkload!)?.label ?? searchWorkload} から）` : ''
                }`
              : focusIds
                ? 'フォーカス表示'
                : '概観（Workload → principal → SA）'}
          <span className="muted"> ・ ノード {displayed.nodes.size}</span>
        </div>
        {graphHidden ? (
          <div className="graph-placeholder">
            <p>
              ノードが {displayed.nodes.size} 件あり、多すぎるためグラフを表示していません（{MAX_GRAPH_NODES} 件まで表示します）。
              <br />
              左のリストでワークロードや検出結果を選ぶか、検索で絞り込んでください。
            </p>
            <button type="button" className="primary" onClick={() => setLargeGraphShown(displayed)}>
              このまま表示する（重くなることがあります）
            </button>
          </div>
        ) : (
          <GraphView graph={displayed} highlightIds={highlightIds} selectedId={selectedNodeId} onSelect={setSelectedNodeId} />
        )}
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
