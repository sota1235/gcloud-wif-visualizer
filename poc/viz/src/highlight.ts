import type { Graph } from './types';

// 選択ノードを通る経路（上流と下流）に含まれるノード・エッジを求める
export function connectedPath(graph: Graph, nodeId: string) {
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const e of graph.edges) {
    out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
    inc.set(e.target, [...(inc.get(e.target) ?? []), e.source]);
  }
  const walk = (adj: Map<string, string[]>) => {
    const seen = new Set([nodeId]);
    const stack = [nodeId];
    while (stack.length) {
      for (const next of adj.get(stack.pop()!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return seen;
  };
  const down = walk(out);
  const up = walk(inc);
  const nodes = new Set([...down, ...up]);
  const edges = new Set(
    graph.edges
      .filter((e) => (down.has(e.source) && down.has(e.target)) || (up.has(e.source) && up.has(e.target)))
      .map((e) => e.id),
  );
  return { nodes, edges };
}
