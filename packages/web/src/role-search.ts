import { assetTypesForPermissions, createResourceCounter, serviceAccountEmailFromResource, type EffectiveAccess, type Snapshot } from '@wif-viz/core';
import { grantNodeId, type ViewGraph } from './view-graph.ts';

export type SearchMode = 'role' | 'permission';

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
  /** permission で検索した場合の、このロールに含まれる一致した permission */
  matchedPermissions?: string[];
  /**
   * permission で検索した場合の、一致した permission が対象とするアセットタイプ。
   * 対応表にない permission（setIamPolicy など）だけの場合は空で、リソースは表示しない
   */
  assetTypes?: string[];
}

/** 大文字小文字を区別せず、空白区切りのすべての語を含むかどうか */
export function matchesTerms(value: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const target = value.toLowerCase();
  return terms.length > 0 && terms.every((term) => target.includes(term));
}

/** WIF から到達できるロールと、それらに含まれる permission（入力候補用） */
export function reachableRolesAndPermissions(snapshot: Snapshot): { roles: string[]; permissions: string[] } {
  const roles = [...new Set(snapshot.effectiveAccess.map((r) => r.role))].sort();
  const permissions = [...new Set(roles.flatMap((role) => snapshot.roles[role] ?? []))].sort();
  return { roles, permissions };
}

interface RoleCondition {
  matchedPermissions?: string[];
  assetTypes?: Set<string>;
}

/**
 * WIF から到達できる付与のうち、クエリに一致するロール（または一致する permission を含むロール）を持つものを、ロールごとにまとめる。
 * 並び順は、到達できる Workload が多い順 → ロール名順。
 */
export function searchAccess(snapshot: Snapshot, view: ViewGraph, query: string, mode: SearchMode = 'role'): RoleMatch[] {
  const workloadsByPrincipal = new Map<string, string[]>();
  for (const edge of view.edges) {
    if (edge.kind !== 'resolves') continue;
    workloadsByPrincipal.set(edge.target, [...(workloadsByPrincipal.get(edge.target) ?? []), edge.source]);
  }

  const conditions = new Map<string, RoleCondition | null>();
  const conditionOf = (role: string): RoleCondition | null => {
    if (conditions.has(role)) return conditions.get(role)!;
    let condition: RoleCondition | null = null;
    if (mode === 'role') {
      condition = matchesTerms(role, query) ? {} : null;
    } else {
      const matchedPermissions = (snapshot.roles[role] ?? []).filter((p) => matchesTerms(p, query));
      if (matchedPermissions.length > 0) {
        condition = { matchedPermissions, assetTypes: new Set(assetTypesForPermissions(matchedPermissions).assetTypes) };
      }
    }
    conditions.set(role, condition);
    return condition;
  };

  const byRole = new Map<string, { grants: Map<string, RoleGrant>; rows: EffectiveAccess[]; principals: Set<string> }>();
  for (const row of snapshot.effectiveAccess) {
    const condition = conditionOf(row.role);
    if (!condition) continue;
    const identity = row.path.at(-1)!;
    const entry = byRole.get(row.role) ?? { grants: new Map<string, RoleGrant>(), rows: [] as EffectiveAccess[], principals: new Set<string>() };
    const email = serviceAccountEmailFromResource(row.grantedOn);
    const viewNodeId = email ? `serviceAccount:${email}` : grantNodeId(identity, row.grantedOn);
    const key = `${identity}|${row.grantedOn}`;
    const grant = entry.grants.get(key) ?? { viewNodeId, identity, grantedOn: row.grantedOn, principals: [] };
    if (!grant.principals.includes(row.principal)) grant.principals.push(row.principal);
    entry.grants.set(key, grant);
    entry.principals.add(row.principal);
    entry.rows.push(row);
    byRole.set(row.role, entry);
  }

  const countResources = createResourceCounter(snapshot);

  return [...byRole]
    .map(([role, entry]) => {
      const condition = conditions.get(role)!;
      return {
        role,
        grants: [...entry.grants.values()].sort((a, b) => a.viewNodeId.localeCompare(b.viewNodeId) || a.identity.localeCompare(b.identity)),
        workloads: [...new Set([...entry.principals].flatMap((p) => workloadsByPrincipal.get(p) ?? []))].sort(),
        // permission 検索では、その permission で操作できるアセットタイプのリソースだけを数える
        resourceCount: countResources(entry.rows, condition.assetTypes ? (type) => condition.assetTypes!.has(type) : undefined),
        ...(condition.matchedPermissions ? { matchedPermissions: condition.matchedPermissions, assetTypes: [...condition.assetTypes!].sort() } : {}),
      };
    })
    .sort((a, b) => b.workloads.length - a.workloads.length || a.role.localeCompare(b.role));
}

/**
 * 検索結果をグラフに表示するときの範囲。付与先から上流を辿る。
 * 付与先の配下は、同じ付与先にある別のロールのリソースまで含まれないよう、一致したロールで到達できるリソースのまとまりだけを表示する。
 * permission で検索した場合は、さらにその permission が対象とするアセットタイプに絞る。
 */
export function roleFocus(matches: RoleMatch[], view: ViewGraph) {
  const grantIds = [...new Set(matches.flatMap((m) => m.grants.map((g) => g.viewNodeId)))].filter((id) => view.nodes.has(id));
  const grantKeys = new Set(matches.flatMap((m) => m.grants.map((g) => `${g.identity}|${g.grantedOn}`)));
  const matchByRole = new Map(matches.map((m) => [m.role, m]));
  const isRelevant = (role: string, assetType: string) => {
    const match = matchByRole.get(role);
    return match !== undefined && (match.assetTypes === undefined || match.assetTypes.includes(assetType));
  };
  const resourceGroupIds = [...view.nodes.values()]
    .filter(
      (n) =>
        n.type === 'resourceGroup' &&
        grantKeys.has(`${n.identity}|${n.grantedOn}`) &&
        n.roles?.some((role) => isRelevant(role, n.assetType ?? '')),
    )
    .map((n) => n.id);
  return {
    highlight: grantIds,
    upstreamFrom: [...grantIds, ...resourceGroupIds],
    downstreamFrom: [],
  };
}

/** 検索結果を、1 つのワークロード（の principal）から到達できる付与だけに絞る */
export function narrowToWorkload(matches: RoleMatch[], view: ViewGraph, workloadId: string): RoleMatch[] {
  const principals = new Set(view.edges.filter((e) => e.kind === 'resolves' && e.source === workloadId).map((e) => e.target));
  return matches
    .map((m) => ({ ...m, workloads: m.workloads.filter((w) => w === workloadId), grants: m.grants.filter((g) => g.principals.some((p) => principals.has(p))) }))
    .filter((m) => m.grants.length > 0);
}
