import { edgeId } from './names.ts';
import type { AccessGraph, EffectiveAccess, GraphEdge, HasRoleEdge, Member, ServiceAccountEdge } from './types.ts';

interface Reach {
  path: Member[];
  conditional: boolean;
}

function outgoingEdges(graph: AccessGraph) {
  const impersonation = new Map<string, ServiceAccountEdge[]>();
  const roles = new Map<string, HasRoleEdge[]>();
  const push = <T extends GraphEdge>(map: Map<string, T[]>, edge: T) => {
    const list = map.get(edge.from) ?? [];
    list.push(edge);
    map.set(edge.from, list);
  };
  for (const edge of graph.edges.values()) {
    if (edge.kind === 'CAN_IMPERSONATE') push(impersonation, edge);
    if (edge.kind === 'HAS_ROLE') push(roles, edge);
  }
  return { impersonation, roles };
}

/** principal から impersonation で到達できる identity と、その最短経路を求める */
export function reachableIdentities(graph: AccessGraph, principal: Member): Map<Member, Reach> {
  const { impersonation } = outgoingEdges(graph);
  return reachFrom(impersonation, principal);
}

function reachFrom(impersonation: Map<string, ServiceAccountEdge[]>, principal: Member): Map<Member, Reach> {
  const reached = new Map<Member, Reach>([[principal, { path: [principal], conditional: false }]]);
  let frontier = [principal];
  while (frontier.length > 0) {
    const next: Member[] = [];
    for (const identity of frontier) {
      const current = reached.get(identity)!;
      // 同じ SA への付与が複数ある場合、条件なしの付与が 1 つでもあれば無条件とみなす
      const byTarget = new Map<Member, boolean>();
      for (const edge of impersonation.get(identity) ?? []) {
        const conditional = edge.condition !== undefined;
        byTarget.set(edge.to, (byTarget.get(edge.to) ?? true) && conditional);
      }
      for (const [target, conditional] of [...byTarget].sort(([a], [b]) => a.localeCompare(b))) {
        if (reached.has(target)) continue;
        reached.set(target, { path: [...current.path, target], conditional: current.conditional || conditional });
        next.push(target);
      }
    }
    frontier = next;
  }
  return reached;
}

/** 実リソースへの展開を行わない（付与箇所単位の）実効アクセスを求める */
export function computeEffectiveAccess(graph: AccessGraph): EffectiveAccess[] {
  const { impersonation, roles } = outgoingEdges(graph);
  const rows = new Map<string, EffectiveAccess>();
  const principals = [...graph.nodes.values()].filter((n) => n.kind === 'principal');

  for (const principal of principals) {
    for (const [identity, reach] of reachFrom(impersonation, principal.id)) {
      for (const edge of roles.get(identity) ?? []) {
        const id = edgeId('ACCESS', principal.id, edge.resource, edge.role, reach.path.join('>'));
        rows.set(id, {
          id,
          principal: principal.id,
          path: reach.path,
          role: edge.role,
          grantedOn: edge.resource,
          resource: edge.resource,
          expanded: false,
          conditional: reach.conditional || edge.condition !== undefined,
        });
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}
