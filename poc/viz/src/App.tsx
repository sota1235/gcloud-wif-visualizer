import { useEffect, useMemo, useState } from 'react';
import { CytoscapeView } from './CytoscapeView';
import { connectedPath } from './highlight';
import { layout } from './layout';
import { ReactFlowView } from './ReactFlowView';
import { type Graph, type Positions, NODE_COLORS } from './types';

const DATASETS = ['real', 'synthetic-s', 'synthetic-m', 'synthetic-l'];
const LIBS = ['reactflow', 'cytoscape'] as const;
type Lib = (typeof LIBS)[number];

const params = new URLSearchParams(location.search);

export function App() {
  const [lib, setLib] = useState<Lib>((params.get('lib') as Lib) ?? 'reactflow');
  const [dataset, setDataset] = useState(params.get('data') ?? 'real');
  const [fullGraph, setFullGraph] = useState<Graph | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [positions, setPositions] = useState<Positions | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(params.get('focus') === '1');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, number>>({});

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('lib', lib);
    url.searchParams.set('data', dataset);
    url.searchParams.set('focus', focusMode ? '1' : '0');
    history.replaceState(null, '', url);
  }, [lib, dataset, focusMode]);

  useEffect(() => {
    setFullGraph(null);
    setSelected(null);
    setFocusId(null);
    fetch(`/data/${dataset}.json`).then(async (res) => setFullGraph(await res.json()));
  }, [dataset]);

  // フォーカス表示: 選択ノードを通る経路のサブグラフだけを表示する
  const displayGraph = useMemo(() => {
    if (!fullGraph || !focusId) return fullGraph;
    const path = connectedPath(fullGraph, focusId);
    return {
      name: `${fullGraph.name}:focus:${focusId}`,
      nodes: fullGraph.nodes.filter((n) => path.nodes.has(n.id)),
      edges: fullGraph.edges.filter((e) => path.edges.has(e.id)),
    };
  }, [fullGraph, focusId]);

  useEffect(() => {
    if (!displayGraph) return;
    let cancelled = false;
    setGraph(null);
    setPositions(null);
    (async () => {
      const start = performance.now();
      const p = await layout(displayGraph);
      if (cancelled) return;
      setMetrics({ nodes: displayGraph.nodes.length, edges: displayGraph.edges.length, layoutMs: Math.round(performance.now() - start) });
      setGraph(displayGraph);
      setPositions(p);
    })();
    return () => {
      cancelled = true;
    };
  }, [displayGraph]);

  const select = (id: string | null) => {
    const start = performance.now();
    setSelected(id);
    if (focusMode) setFocusId(id);
    requestAnimationFrame(() => requestAnimationFrame(() => setMetrics((m) => ({ ...m, highlightMs: Math.round(performance.now() - start) }))));
  };

  // 計測用フック（DevTools から呼び出す）
  Object.assign(window, {
    __select: select,
    __graph: graph,
    __benchZoom: async (frames = 90) => {
      const main = document.querySelector('main')!;
      const rect = main.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)!;
      const durations: number[] = [];
      let last = performance.now();
      for (let i = 0; i < frames; i++) {
        target.dispatchEvent(
          new WheelEvent('wheel', { deltaY: i < frames / 2 ? -40 : 40, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }),
        );
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        durations.push(now - last);
        last = now;
      }
      durations.sort((a, b) => a - b);
      return { p50: Math.round(durations[Math.floor(frames / 2)]), p95: Math.round(durations[Math.floor(frames * 0.95)]), max: Math.round(durations[frames - 1]) };
    },
  });

  const selectedNode = graph?.nodes.find((n) => n.id === selected);
  const viewProps = graph && positions
    ? { graph, positions, selected, onSelect: select, onRendered: (ms: number) => setMetrics((m) => ({ ...m, renderMs: Math.round(ms) })) }
    : null;

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <header style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
        <label>
          lib{' '}
          <select value={lib} onChange={(e) => setLib(e.target.value as Lib)}>
            {LIBS.map((l) => <option key={l}>{l}</option>)}
          </select>
        </label>
        <label>
          data{' '}
          <select value={dataset} onChange={(e) => setDataset(e.target.value)}>
            {DATASETS.map((d) => <option key={d}>{d}</option>)}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={focusMode}
            onChange={(e) => {
              setFocusMode(e.target.checked);
              setFocusId(e.target.checked ? selected : null);
            }}
          />{' '}
          フォーカス表示
        </label>
        <code id="metrics">{JSON.stringify(metrics)}</code>
        <span style={{ display: 'flex', gap: 8, fontSize: 12 }}>
          {Object.entries(NODE_COLORS).map(([type, color]) => (
            <span key={type} style={{ borderLeft: `12px solid ${color}`, paddingLeft: 4 }}>{type}</span>
          ))}
        </span>
        {selectedNode && <code style={{ fontSize: 11 }}>{selectedNode.detail ?? selectedNode.label}</code>}
      </header>
      <main style={{ minHeight: 0 }}>
        {!viewProps ? <p style={{ padding: 16 }}>layout...</p> : lib === 'reactflow' ? <ReactFlowView key={graph!.name} {...viewProps} /> : <CytoscapeView key={graph!.name} {...viewProps} />}
      </main>
    </div>
  );
}
