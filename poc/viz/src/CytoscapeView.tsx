import { useEffect, useRef } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import { connectedPath } from './highlight';
import { type Graph, type Positions, EDGE_COLORS, NODE_COLORS, NODE_HEIGHT, NODE_WIDTH } from './types';

type Props = {
  graph: Graph;
  positions: Positions;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onRendered: (ms: number) => void;
};

export function CytoscapeView({ graph, positions, selected, onSelect, onRendered }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  useEffect(() => {
    const start = performance.now();
    const cy = cytoscape({
      container: containerRef.current,
      minZoom: 0.02,
      elements: [
        ...graph.nodes.map((n) => {
          // ELK は左上座標、Cytoscape は中心座標
          const p = positions.get(n.id) ?? { x: 0, y: 0 };
          return { data: { id: n.id, label: n.label, color: NODE_COLORS[n.type] }, position: { x: p.x + NODE_WIDTH / 2, y: p.y + NODE_HEIGHT / 2 } };
        }),
        ...graph.edges.map((e) => ({
          data: { id: e.id, source: e.source, target: e.target, label: e.label ?? '', color: EDGE_COLORS[e.kind], kind: e.kind },
        })),
      ],
      layout: { name: 'preset' },
      autoungrabify: true,
      style: [
        {
          selector: 'node',
          style: {
            shape: 'round-rectangle',
            width: NODE_WIDTH,
            height: NODE_HEIGHT,
            'background-color': '#fff',
            'border-width': 2,
            'border-color': 'data(color)',
            label: 'data(label)',
            'font-size': 12,
            'text-valign': 'center',
            'text-halign': 'center',
            'text-max-width': `${NODE_WIDTH - 16}px`,
            'text-wrap': 'ellipsis',
            'min-zoomed-font-size': 6,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': 'data(color)',
            'target-arrow-color': 'data(color)',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            label: 'data(label)',
            'font-size': 10,
            'min-zoomed-font-size': 8,
            'text-background-color': '#fff',
            'text-background-opacity': 1,
          },
        },
        { selector: 'edge[kind = "actAs"]', style: { 'line-style': 'dashed' } },
        { selector: 'node.selected', style: { 'background-color': 'data(color)', color: '#fff' } },
        { selector: '.dim', style: { opacity: 0.1 } },
        { selector: 'edge.hl', style: { width: 2.5 } },
      ],
    });
    cy.on('tap', 'node', (evt) => onSelect(evt.target.id()));
    cy.on('tap', (evt) => {
      if (evt.target === cy) onSelect(null);
    });
    cy.fit(undefined, 20);
    cyRef.current = cy;
    requestAnimationFrame(() => requestAnimationFrame(() => onRendered(performance.now() - start)));
    return () => cy.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, positions]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const path = selected ? connectedPath(graph, selected) : null;
    cy.batch(() => {
      cy.elements().removeClass('dim hl selected');
      if (!path) return;
      cy.nodes().forEach((n) => {
        if (!path.nodes.has(n.id())) n.addClass('dim');
      });
      cy.edges().forEach((e) => {
        e.addClass(path.edges.has(e.id()) ? 'hl' : 'dim');
      });
      cy.getElementById(selected!).addClass('selected');
    });
  }, [graph, selected]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
