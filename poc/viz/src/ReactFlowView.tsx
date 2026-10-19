import { useEffect, useMemo, useRef } from 'react';
import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { connectedPath } from './highlight';
import { type Graph, type Positions, EDGE_COLORS, NODE_COLORS, NODE_HEIGHT, NODE_WIDTH } from './types';

type Props = {
  graph: Graph;
  positions: Positions;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onRendered: (ms: number) => void;
};

export function ReactFlowView({ graph, positions, selected, onSelect, onRendered }: Props) {
  const mountedAt = useRef(performance.now());
  const path = useMemo(() => (selected ? connectedPath(graph, selected) : null), [graph, selected]);

  const nodes: Node[] = useMemo(
    () =>
      graph.nodes.map((n) => ({
        id: n.id,
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { label: n.label },
        sourcePosition: 'right' as never,
        targetPosition: 'left' as never,
        style: {
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          padding: '0 8px',
          display: 'flex',
          alignItems: 'center',
          fontSize: 12,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          border: `2px solid ${NODE_COLORS[n.type]}`,
          background: n.id === selected ? NODE_COLORS[n.type] : '#fff',
          color: n.id === selected ? '#fff' : '#0f172a',
          opacity: path && !path.nodes.has(n.id) ? 0.15 : 1,
        },
      })),
    [graph, positions, selected, path],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        labelStyle: { fontSize: 10 },
        style: {
          stroke: EDGE_COLORS[e.kind],
          strokeWidth: path?.edges.has(e.id) ? 2.5 : 1.5,
          strokeDasharray: e.kind === 'actAs' ? '6 4' : undefined,
          opacity: path && !path.edges.has(e.id) ? 0.08 : 1,
        },
      })),
    [graph, path],
  );

  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => onRendered(performance.now() - mountedAt.current)));
    // 初回マウント時のみ計測する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      nodesDraggable={false}
      onlyRenderVisibleElements
      minZoom={0.02}
      fitView
    >
      <Background />
      <Controls />
      <MiniMap pannable zoomable nodeColor={(n) => NODE_COLORS[graph.nodes.find((g) => g.id === n.id)?.type ?? 'container']} />
    </ReactFlow>
  );
}
