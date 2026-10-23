import type { ViewEdge, ViewEdgeKind, ViewGraph } from './view-graph.ts';

// actAs は「そこから先の権限を潜在的に得られる」関係なので、経路としては辿らない
const PATH_EDGE_KINDS: ReadonlySet<ViewEdgeKind> = new Set(['resolves', 'impersonate', 'role', 'resources']);

function adjacency(edges: ViewEdge[]) {
  const down = new Map<string, string[]>();
  const up = new Map<string, string[]>();
  for (const e of edges) {
    if (!PATH_EDGE_KINDS.has(e.kind)) continue;
    down.set(e.source, [...(down.get(e.source) ?? []), e.target]);
    up.set(e.target, [...(up.get(e.target) ?? []), e.source]);
  }
  return { down, up };
}

function walk(starts: string[], adj: Map<string, string[]>): Set<string> {
  const seen = new Set(starts);
  const stack = [...starts];
  while (stack.length > 0) {
    for (const next of adj.get(stack.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** 選択ノードを通る経路（上流と下流）だけのサブグラフ */
export function focusSubgraph(view: ViewGraph, focusIds: string[]): ViewGraph {
  return pathSubgraph(view, focusIds, focusIds);
}

/** upstreamFrom から上流、downstreamFrom から下流を辿ったサブグラフ */
export function pathSubgraph(view: ViewGraph, upstreamFrom: string[], downstreamFrom: string[]): ViewGraph {
  const present = (ids: string[]) => ids.filter((id) => view.nodes.has(id));
  const { down, up } = adjacency(view.edges);
  const ids = new Set([...walk(present(upstreamFrom), up), ...walk(present(downstreamFrom), down)]);
  return {
    nodes: new Map([...view.nodes].filter(([id]) => ids.has(id))),
    edges: view.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  };
}

/** 概観: Workload → principal → SA（impersonation）の層だけを表示する */
export function overviewGraph(view: ViewGraph): ViewGraph {
  const edges = view.edges.filter((e) => e.kind === 'resolves' || e.kind === 'impersonate');
  const ids = new Set(edges.flatMap((e) => [e.source, e.target]));
  for (const node of view.nodes.values()) if (node.type === 'workload') ids.add(node.id);
  return { nodes: new Map([...view.nodes].filter(([id]) => ids.has(id))), edges };
}

/** graph のうち、fromId から下流に辿れるノードだけを残す（ほかのワークロードからの経路を除くため） */
export function downstreamSubgraph(graph: ViewGraph, fromId: string): ViewGraph {
  const ids = walk([fromId].filter((id) => graph.nodes.has(id)), adjacency(graph.edges).down);
  return {
    nodes: new Map([...graph.nodes].filter(([id]) => ids.has(id))),
    edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  };
}
