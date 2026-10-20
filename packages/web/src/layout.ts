import ELK from 'elkjs/lib/elk-api.js';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';
import type { ViewGraph } from './view-graph.ts';

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 52;

// レイアウト計算はメインスレッドを止めないよう Web Worker で行う
const elk = new ELK({
  workerFactory: () => new Worker(elkWorkerUrl),
});

export type Positions = Map<string, { x: number; y: number }>;

export async function layoutGraph(graph: ViewGraph): Promise<Positions> {
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '16',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: [...graph.nodes.keys()].map((id) => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  return new Map((result.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}
