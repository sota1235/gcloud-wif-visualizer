// 描画 PoC 用のグラフ JSON を生成する
//   real.json: probe / expand の出力から作る実データ
//   synthetic-{s,m,l}.json: 規模検証用の合成データ
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export type NodeType = 'pool' | 'principal' | 'sa' | 'container' | 'resourceGroup';
export type EdgeKind = 'trusts' | 'impersonate' | 'actAs' | 'role' | 'contains';
export type GraphNode = { id: string; type: NodeType; label: string; detail?: string };
export type GraphEdge = { id: string; source: string; target: string; kind: EdgeKind; label?: string };
export type Graph = { name: string; nodes: GraphNode[]; edges: GraphEdge[] };

class GraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge & { labels: Set<string> }>();

  node(id: string, type: NodeType, label: string, detail?: string) {
    if (!this.nodes.has(id)) this.nodes.set(id, { id, type, label, detail });
  }

  // 同じ source/target/kind のエッジは 1 本にまとめ、ラベル（ロール）を集約する
  edge(source: string, target: string, kind: EdgeKind, label?: string) {
    if (source === target) return;
    const id = `${kind}:${source}->${target}`;
    const existing = this.edges.get(id) ?? { id, source, target, kind, labels: new Set<string>() };
    if (label) existing.labels.add(label);
    this.edges.set(id, existing);
  }

  build(name: string): Graph {
    const edges = [...this.edges.values()].map(({ labels, ...e }) => ({
      ...e,
      label: labels.size === 0 ? undefined : labels.size === 1 ? [...labels][0] : `${labels.size} roles`,
    }));
    return { name, nodes: [...this.nodes.values()], edges };
  }
}

const shortRole = (role: string) => role.replace(/^roles\//, '');
const shortSa = (member: string) => member.replace(/^serviceAccount:/, '').replace(/\.iam\.gserviceaccount\.com$/, '');
const shortContainer = (name: string) => name.replace(/^\/\/cloudresourcemanager\.googleapis\.com\//, '');

async function realGraph(): Promise<Graph> {
  const raw = JSON.parse(await readFile(new URL('../out/raw.json', import.meta.url), 'utf8'));
  const expand = JSON.parse(await readFile(new URL('../out/expand.json', import.meta.url), 'utf8'));
  const g = new GraphBuilder();

  for (const e of raw.edges as { from: string; to: string; kind: string; role: string; grantedOn: string }[]) {
    const fromId = e.from;
    if (fromId.includes('/workloadIdentityPools/')) {
      const [, pool, attr] = fromId.match(/workloadIdentityPools\/([^/]+)\/(.+)$/) ?? [];
      g.node(`pool:${pool}`, 'pool', pool);
      g.node(fromId, 'principal', attr.replace(/^attribute\./, ''), fromId);
      g.edge(`pool:${pool}`, fromId, 'trusts');
    } else {
      g.node(fromId, 'sa', shortSa(fromId), fromId);
    }

    if (e.kind === 'HAS_ROLE') {
      g.node(e.grantedOn, 'container', shortContainer(e.grantedOn), e.grantedOn);
      g.edge(fromId, e.grantedOn, 'role', shortRole(e.role));
    } else {
      g.node(e.to, 'sa', shortSa(e.to), e.to);
      g.edge(fromId, e.to, e.kind === 'CAN_IMPERSONATE' ? 'impersonate' : 'actAs', shortRole(e.role));
    }
  }

  // 実リソースは「アセットタイプ × project」に集約して container にぶら下げる
  const roleEdges = (raw.edges as { from: string; kind: string; grantedOn: string; role: string }[]).filter((e) => e.kind === 'HAS_ROLE');
  const groups = new Map<string, Set<string>>();
  const groupMeta = new Map<string, { project: string; assetType: string }>();
  for (const a of expand.accessA as { identity: string; resource: string; role: string; assetType: string }[]) {
    const project = a.resource.match(/projects\/([^/]+)/)?.[1] ?? '?';
    for (const e of roleEdges.filter((r) => r.from === a.identity && r.role === a.role)) {
      const groupId = `rg:${e.grantedOn}:${project}:${a.assetType}`;
      const set = groups.get(groupId) ?? new Set();
      set.add(a.resource);
      groups.set(groupId, set);
      groupMeta.set(groupId, { project, assetType: a.assetType });
      g.edge(e.grantedOn, groupId, 'contains');
    }
  }
  for (const [groupId, resources] of groups) {
    const { project, assetType } = groupMeta.get(groupId)!;
    g.node(groupId, 'resourceGroup', `${assetType.split('/').pop()} ×${resources.size}`, `${project} / ${assetType}`);
  }
  return g.build('real');
}

// 決定的な疑似乱数（seed 固定で毎回同じデータを生成する）
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
}

function syntheticGraph(name: string, scale: { pools: number; principalsPerPool: number; sas: number; projects: number }): Graph {
  const rand = rng(42);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const g = new GraphBuilder();
  const roles = ['storage.admin', 'run.admin', 'secretmanager.secretAccessor', 'artifactregistry.writer', 'bigquery.dataEditor', 'viewer', 'editor', 'pubsub.publisher'];
  const assetTypes = ['Bucket', 'Service', 'Secret', 'Repository', 'Dataset', 'Topic'];

  const projects = Array.from({ length: scale.projects }, (_, i) => `projects/proj-${i}`);
  for (const p of projects) {
    g.node(p, 'container', p);
    for (const t of assetTypes) {
      if (rand() < 0.5) continue;
      const id = `rg:${p}:${t}`;
      g.node(id, 'resourceGroup', `${t} ×${1 + Math.floor(rand() * 30)}`);
      g.edge(p, id, 'contains');
    }
  }

  const sas = Array.from({ length: scale.sas }, (_, i) => `serviceAccount:sa-${i}`);
  for (const sa of sas) {
    g.node(sa, 'sa', sa.replace('serviceAccount:', ''));
    const roleCount = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < roleCount; i++) g.edge(sa, pick(projects), 'role', pick(roles));
    if (rand() < 0.15) g.edge(sa, pick(sas), 'impersonate', 'iam.serviceAccountTokenCreator');
    if (rand() < 0.1) g.edge(sa, pick(sas), 'actAs', 'iam.serviceAccountUser');
  }

  for (let p = 0; p < scale.pools; p++) {
    const pool = `pool:github-pool-${p}`;
    g.node(pool, 'pool', `github-pool-${p}`);
    for (let i = 0; i < scale.principalsPerPool; i++) {
      const principal = `principalSet:${p}:${i}`;
      g.node(principal, 'principal', `repository/org-${p}/repo-${i}`);
      g.edge(pool, principal, 'trusts');
      g.edge(principal, pick(sas), 'impersonate', 'iam.workloadIdentityUser');
      if (rand() < 0.1) g.edge(principal, pick(projects), 'role', pick(roles));
    }
  }
  return g.build(name);
}

const outDir = new URL('../viz/public/data/', import.meta.url);
await mkdir(outDir, { recursive: true });
const graphs = [
  await realGraph(),
  syntheticGraph('synthetic-s', { pools: 3, principalsPerPool: 5, sas: 15, projects: 8 }),
  syntheticGraph('synthetic-m', { pools: 15, principalsPerPool: 12, sas: 150, projects: 60 }),
  syntheticGraph('synthetic-l', { pools: 40, principalsPerPool: 25, sas: 800, projects: 300 }),
];
for (const graph of graphs) {
  await writeFile(new URL(`${graph.name}.json`, outDir), JSON.stringify(graph));
  console.log(`${graph.name}: nodes=${graph.nodes.length} edges=${graph.edges.length}`);
}
