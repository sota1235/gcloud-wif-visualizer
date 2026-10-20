import type { EffectiveAccess, Finding, GraphNode, Snapshot } from '@wif-viz/core';

export type ViewNodeType = 'workload' | 'principal' | 'serviceAccount' | 'grant' | 'resourceGroup';
export type ViewEdgeKind = 'resolves' | 'impersonate' | 'actAs' | 'role' | 'resources';

export interface ViewNode {
  id: string;
  type: ViewNodeType;
  label: string;
  sublabel?: string;
  /** 元のグラフノード（workload / principal / SA） */
  source?: GraphNode;
  /** grant: このノードに付与されているロール */
  roles?: string[];
  /** grant / resourceGroup: 付与箇所 */
  grantedOn?: string;
  /** grant / resourceGroup: ロールを持つ identity */
  identity?: string;
  /** resourceGroup: リソース一覧 */
  resources?: { name: string; assetType?: string; roles: string[] }[];
  /** このノードに関連する検出結果の最大重要度 */
  severity?: Finding['severity'];
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  kind: ViewEdgeKind;
  label?: string;
}

export interface ViewGraph {
  nodes: Map<string, ViewNode>;
  edges: ViewEdge[];
}

const CRM = '//cloudresourcemanager.googleapis.com/';

export function shortResource(name: string): string {
  return name.startsWith(CRM) ? name.slice(CRM.length) : name.replace(/^\/\//, '');
}

export function shortServiceAccount(member: string): string {
  return member.replace(/^serviceAccount:/, '').replace(/\.iam\.gserviceaccount\.com$/, '');
}

export function shortAssetType(assetType: string): string {
  return assetType.split('/').pop() ?? assetType;
}

export const grantNodeId = (identity: string, grantedOn: string) => `grant|${identity}|${grantedOn}`;
const resourceGroupId = (identity: string, grantedOn: string, assetType: string) => `rg|${identity}|${grantedOn}|${assetType}`;

function principalLabel(node: Extract<GraphNode, { kind: 'principal' }>): string {
  if (node.principalKind === 'all') return `${node.poolId} / *`;
  if (node.principalKind === 'attribute') return `${node.attributeKey}: ${node.value}`;
  return `${node.principalKind}: ${node.value}`;
}

const rolesLabel = (roles: string[]) => (roles.length === 1 ? roles[0]!.replace(/^roles\//, '') : `${roles.length} roles`);

/**
 * スナップショットを表示用のグラフに変換する。
 * 付与先（container / リソース）は「identity × 付与箇所」ごとに別ノード（grant）にし、
 * 別の identity の付与までハイライトや経路に含まれないようにする。
 */
export function buildViewGraph(snapshot: Snapshot, findings: Finding[] = []): ViewGraph {
  const nodes = new Map<string, ViewNode>();
  const edges = new Map<string, ViewEdge & { labels?: Set<string> }>();
  const addEdge = (source: string, target: string, kind: ViewEdgeKind, label?: string) => {
    const id = `${kind}|${source}|${target}`;
    const edge = edges.get(id) ?? { id, source, target, kind, labels: new Set<string>() };
    if (label) edge.labels!.add(label);
    edges.set(id, edge);
  };

  for (const node of snapshot.nodes) {
    if (node.kind === 'workload') {
      nodes.set(node.id, { id: node.id, type: 'workload', label: node.workload.label, sublabel: node.workload.confidence === 'partial' ? '推定: 一部のみ' : undefined, source: node });
    } else if (node.kind === 'principal') {
      nodes.set(node.id, { id: node.id, type: 'principal', label: principalLabel(node), sublabel: `pool: ${node.poolId}`, source: node });
    } else if (node.kind === 'serviceAccount') {
      nodes.set(node.id, { id: node.id, type: 'serviceAccount', label: shortServiceAccount(node.id), sublabel: node.missing ? '存在しない SA' : undefined, source: node });
    }
  }

  for (const edge of snapshot.edges) {
    if (edge.kind === 'RESOLVES_TO') addEdge(edge.from, edge.to, 'resolves');
    else if (edge.kind === 'CAN_IMPERSONATE') addEdge(edge.from, edge.to, 'impersonate', edge.role);
    else if (edge.kind === 'CAN_ACT_AS') addEdge(edge.from, edge.to, 'actAs', edge.role);
    else if (edge.kind === 'HAS_ROLE' && nodes.has(edge.from)) {
      // SA リソースへの付与は impersonate / actAs のエッジで表すため、grant ノードは作らない
      if (edge.to.startsWith('serviceAccount:')) continue;
      const id = grantNodeId(edge.from, edge.resource);
      const grant = nodes.get(id) ?? { id, type: 'grant' as const, label: shortResource(edge.resource), grantedOn: edge.resource, identity: edge.from, roles: [] };
      if (!grant.roles!.includes(edge.role)) grant.roles!.push(edge.role);
      nodes.set(id, grant);
      addEdge(edge.from, id, 'role', edge.role);
    }
  }

  // 実リソースは「identity × 付与箇所 × アセットタイプ」でまとめる（container への付与のみ）
  const rowsByGroup = new Map<string, EffectiveAccess[]>();
  for (const row of snapshot.effectiveAccess) {
    if (row.grantedOnKind !== 'container') continue;
    const identity = row.path.at(-1)!;
    for (const resource of row.resources) {
      const id = resourceGroupId(identity, row.grantedOn, resource.assetType ?? 'unknown');
      rowsByGroup.set(id, [...(rowsByGroup.get(id) ?? []), row]);
    }
  }
  for (const [id, rows] of rowsByGroup) {
    const [, identity = '', grantedOn = '', assetType = ''] = id.split('|');
    const resources = new Map<string, { name: string; assetType?: string; roles: Set<string> }>();
    for (const row of rows) {
      for (const r of row.resources.filter((x) => (x.assetType ?? 'unknown') === assetType)) {
        const entry = resources.get(r.name) ?? { name: r.name, ...(r.assetType ? { assetType: r.assetType } : {}), roles: new Set<string>() };
        entry.roles.add(row.role);
        resources.set(r.name, entry);
      }
    }
    nodes.set(id, {
      id,
      type: 'resourceGroup',
      label: `${shortAssetType(assetType)} ×${resources.size}`,
      sublabel: shortResource(grantedOn),
      grantedOn,
      identity,
      resources: [...resources.values()].map((r) => ({ ...r, roles: [...r.roles].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    });
    addEdge(grantNodeId(identity, grantedOn), id, 'resources');
  }

  for (const grant of nodes.values()) {
    if (grant.type === 'grant') grant.sublabel = rolesLabel(grant.roles!.sort());
  }

  // 検出結果の重要度をノードに付ける
  const order = { high: 0, medium: 1, low: 2 };
  for (const finding of findings) {
    for (const id of findingNodeIds(finding)) {
      const node = nodes.get(id);
      if (node && (!node.severity || order[finding.severity] < order[node.severity])) node.severity = finding.severity;
    }
  }

  return {
    nodes,
    edges: [...edges.values()].map(({ labels, ...e }) => ({
      ...e,
      ...(labels && labels.size > 0 ? { label: labels.size === 1 ? [...labels][0]!.replace(/^roles\//, '') : `${labels.size} roles` } : {}),
    })),
  };
}

/** 検出結果に対応する表示ノード。バインディングが原因の場合は grant ノードを含める */
export function findingNodeIds(finding: Finding): string[] {
  const ids = [...finding.nodeIds];
  if (finding.cause.kind === 'binding' && finding.cause.grantedOn) ids.push(grantNodeId(finding.cause.ref, finding.cause.grantedOn));
  return ids;
}

export interface FindingFocus {
  /** 強調するノード */
  highlight: string[];
  /** 上流（どのワークロードから来るか）を辿る起点 */
  upstreamFrom: string[];
  /** 下流（何に到達するか）を辿る起点 */
  downstreamFrom: string[];
}

/**
 * 検出結果を表示する範囲。原因の identity から先をすべて辿ると関係のない権限まで表示されるため、
 * バインディングが原因なら「その付与の先」だけ、経路なら「経路の終点の先」だけを辿る。
 */
export function findingFocus(finding: Finding, view: ViewGraph): FindingFocus {
  const ids = findingNodeIds(finding).filter((id) => view.nodes.has(id));
  if (finding.cause.kind === 'provider') {
    // Provider は表示ノードにないため、その Provider から推定したワークロードで代替する
    const workloads = [...view.nodes.values()]
      .filter((n) => n.source?.kind === 'workload' && n.source.workload.provider === finding.cause.ref)
      .map((n) => n.id);
    return { highlight: workloads, upstreamFrom: workloads, downstreamFrom: workloads };
  }
  if (finding.cause.kind === 'binding') {
    return { highlight: ids, upstreamFrom: ids, downstreamFrom: ids.filter((id) => id !== finding.cause.ref) };
  }
  if (finding.cause.kind === 'path') {
    return { highlight: ids, upstreamFrom: ids, downstreamFrom: ids.slice(-1) };
  }
  return { highlight: ids, upstreamFrom: ids, downstreamFrom: ids };
}
