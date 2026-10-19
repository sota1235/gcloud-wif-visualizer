import ELK from 'elkjs/lib/elk.bundled.js';
import { type Graph, type Positions, NODE_HEIGHT, NODE_WIDTH } from './types';

const elk = new ELK();

// 左から右への階層レイアウト。両ライブラリに同じ座標を渡して描画だけを比較する
export async function layout(graph: Graph): Promise<Positions> {
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
      'elk.spacing.nodeNode': '12',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: graph.nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  return new Map((result.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}
