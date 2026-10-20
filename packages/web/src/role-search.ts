import { serviceAccountEmailFromResource, type Snapshot } from '@wif-viz/core';
import { grantNodeId, type ViewGraph } from './view-graph.ts';

/** 1 つの付与（identity × 付与箇所）。表示上のノードに対応づけて持つ */
export interface RoleGrant {
  /** 表示ノードの ID（grant ノード、SA への付与なら SA ノード） */
  viewNodeId: string;
  /** ロールを持つ identity */
  identity: string;
  grantedOn: string;
  /** この付与に到達できる WIF principal */
  principals: string[];
}

export interface RoleMatch {
  role: string;
  grants: RoleGrant[];
  /** 到達できる Workload の ID */
  workloads: string[];
  resourceCount: number;
}

/** 大文字小文字を区別せず、空白区切りのすべての語を含むロールに一致させる */
export function matchesRole(role: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const target = role.toLowerCase();
  return terms.length > 0 && terms.every((term) => target.includes(term));
}

/**
 * WIF から到達できる付与のうち、クエリに一致するロールを持つものを、ロールごとにまとめる。
 * 並び順は、到達できる Workload が多い順 → ロール名順。
 */
export function searchRoles(snapshot: Snapshot, view: ViewGraph, query: string): RoleMatch[] {
  const workloadsByPrincipal = new Map<string, string[]>();
  for (const edge of view.edges) {
    if (edge.kind !== 'resolves') continue;
    workloadsByPrincipal.set(edge.target, [...(workloadsByPrincipal.get(edge.target) ?? []), edge.source]);
  }

  const byRole = new Map<string, { grants: Map<string, RoleGrant>; resources: Set<string>; principals: Set<string> }>();
  for (const row of snapshot.effectiveAccess) {
    if (!matchesRole(row.role, query)) continue;
    const identity = row.path.at(-1)!;
    const entry = byRole.get(row.role) ?? { grants: new Map(), resources: new Set(), principals: new Set() };
    const email = serviceAccountEmailFromResource(row.grantedOn);
    const viewNodeId = email ? `serviceAccount:${email}` : grantNodeId(identity, row.grantedOn);
    const key = `${identity}|${row.grantedOn}`;
    const grant = entry.grants.get(key) ?? { viewNodeId, identity, grantedOn: row.grantedOn, principals: [] };
    if (!grant.principals.includes(row.principal)) grant.principals.push(row.principal);
    entry.grants.set(key, grant);
    entry.principals.add(row.principal);
    for (const r of row.resources) entry.resources.add(r.name);
    byRole.set(row.role, entry);
  }

  return [...byRole]
    .map(([role, entry]) => ({
      role,
      grants: [...entry.grants.values()].sort((a, b) => a.viewNodeId.localeCompare(b.viewNodeId) || a.identity.localeCompare(b.identity)),
      workloads: [...new Set([...entry.principals].flatMap((p) => workloadsByPrincipal.get(p) ?? []))].sort(),
      resourceCount: entry.resources.size,
    }))
    .sort((a, b) => b.workloads.length - a.workloads.length || a.role.localeCompare(b.role));
}

/**
 * 検索結果をグラフに表示するときの範囲。付与先から上流を辿る。
 * 付与先の配下は、同じ付与先にある別のロールのリソースまで含まれないよう、一致したロールで到達できるリソースのまとまりだけを表示する。
 */
export function roleFocus(matches: RoleMatch[], view: ViewGraph) {
  const grantIds = [...new Set(matches.flatMap((m) => m.grants.map((g) => g.viewNodeId)))].filter((id) => view.nodes.has(id));
  const grantKeys = new Set(matches.flatMap((m) => m.grants.map((g) => `${g.identity}|${g.grantedOn}`)));
  const roles = new Set(matches.map((m) => m.role));
  const resourceGroupIds = [...view.nodes.values()]
    .filter(
      (n) =>
        n.type === 'resourceGroup' &&
        grantKeys.has(`${n.identity}|${n.grantedOn}`) &&
        n.resources?.some((r) => r.roles.some((role) => roles.has(role))),
    )
    .map((n) => n.id);
  return {
    highlight: grantIds,
    upstreamFrom: [...grantIds, ...resourceGroupIds],
    downstreamFrom: [],
  };
}
