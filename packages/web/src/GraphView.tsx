import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { layoutGraph, NODE_HEIGHT, NODE_WIDTH, type Positions } from './layout.ts';
import type { ViewEdgeKind, ViewGraph, ViewNode } from './view-graph.ts';

const TYPE_LABELS: Record<ViewNode['type'], string> = {
  workload: 'Workload',
  principal: 'Principal',
  serviceAccount: 'SA',
  grant: '付与先',
  resourceGroup: 'リソース',
};

type CardData = { node: ViewNode; highlighted: boolean; selected: boolean };

function NodeCard({ data }: NodeProps<Node<CardData>>) {
  const { node, highlighted, selected } = data;
  return (
    <div
      className={`node-card type-${node.type}${highlighted ? ' highlighted' : ''}${selected ? ' selected' : ''}`}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      title={node.label}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-card-head">
        <span className="node-type">{TYPE_LABELS[node.type]}</span>
        {node.severity && <span className={`severity-dot severity-${node.severity}`} title={`検出: ${node.severity}`} />}
      </div>
      <div className="node-label">{node.label}</div>
      {node.sublabel && <div className="node-sublabel">{node.sublabel}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { card: NodeCard };

const EDGE_STYLES: Record<ViewEdgeKind, { stroke: string; dash?: string }> = {
  resolves: { stroke: 'var(--edge-resolves)' },
  impersonate: { stroke: 'var(--edge-impersonate)' },
  actAs: { stroke: 'var(--edge-actas)', dash: '6 4' },
  role: { stroke: 'var(--edge-role)' },
  resources: { stroke: 'var(--edge-resources)' },
};

interface Props {
  graph: ViewGraph;
  highlightIds: string[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function GraphView({ graph, highlightIds, selectedId, onSelect }: Props) {
  const [positions, setPositions] = useState<Positions | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPositions(null);
    layoutGraph(graph).then((p) => {
      if (!cancelled) setPositions(p);
    });
    return () => {
      cancelled = true;
    };
  }, [graph]);

  const highlight = useMemo(() => new Set(highlightIds), [highlightIds]);
  // 表示するグラフが変わったら React Flow を作り直して fitView させる
  const flowKey = useMemo(() => [...graph.nodes.keys()].sort().join('|'), [graph]);
  const hasHighlight = highlightIds.some((id) => graph.nodes.has(id));

  const nodes: Node<CardData>[] = useMemo(
    () =>
      positions
        ? [...graph.nodes.values()].map((node) => ({
            id: node.id,
            type: 'card',
            position: positions.get(node.id) ?? { x: 0, y: 0 },
            data: { node, highlighted: highlight.has(node.id), selected: node.id === selectedId },
          }))
        : [],
    [graph, positions, highlight, selectedId],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => {
        const style = EDGE_STYLES[e.kind];
        const emphasized = hasHighlight && highlight.has(e.source) && highlight.has(e.target);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          labelStyle: { fontSize: 11 },
          animated: emphasized,
          style: { stroke: style.stroke, strokeWidth: emphasized ? 3 : 1.5, strokeDasharray: style.dash },
        };
      }),
    [graph, highlight, hasHighlight],
  );

  if (!positions) return <div className="graph-placeholder">レイアウトを計算しています…</div>;
  if (graph.nodes.size === 0) return <div className="graph-placeholder">表示するノードがありません</div>;

  return (
    <ReactFlow
      key={flowKey}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.05}
      fitView
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
