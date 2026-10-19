// PoC 第 2 段: リソース展開方式の比較
//   (a) 自前: permission → アセットタイプ対応表 + searchAllResources のインベントリ
//   (b) ハイブリッド: 到達した SA ごとに Policy Analyzer、principal への直接付与は (a)
// 入力は probe.ts が出力した out/raw.json
import { readFile, writeFile } from 'node:fs/promises';
import { AssetServiceClient } from '@google-cloud/asset';

const raw = JSON.parse(await readFile(new URL('../out/raw.json', import.meta.url), 'utf8')) as {
  org: string;
  edges: { from: string; to: string; kind: string; role: string; grantedOn: string }[];
  roles: Record<string, string[]>;
};
const SCOPE = `organizations/${raw.org}`;
const asset = new AssetServiceClient();

// permission の "service.collection" → アセットタイプ
const PERMISSION_ASSET_TYPES: Record<string, string[]> = {
  'storage.buckets': ['storage.googleapis.com/Bucket'],
  'storage.objects': ['storage.googleapis.com/Bucket'],
  'bigquery.datasets': ['bigquery.googleapis.com/Dataset'],
  'bigquery.tables': ['bigquery.googleapis.com/Table'],
  'secretmanager.secrets': ['secretmanager.googleapis.com/Secret'],
  'secretmanager.versions': ['secretmanager.googleapis.com/Secret'],
  'artifactregistry.repositories': ['artifactregistry.googleapis.com/Repository'],
  'artifactregistry.dockerimages': ['artifactregistry.googleapis.com/Repository'],
  'run.services': ['run.googleapis.com/Service'],
  'run.jobs': ['run.googleapis.com/Job'],
  'cloudfunctions.functions': ['cloudfunctions.googleapis.com/CloudFunction', 'cloudfunctions.googleapis.com/Function'],
  'pubsub.topics': ['pubsub.googleapis.com/Topic'],
  'pubsub.subscriptions': ['pubsub.googleapis.com/Subscription'],
  'compute.instances': ['compute.googleapis.com/Instance'],
  'container.clusters': ['container.googleapis.com/Cluster'],
  'cloudsql.instances': ['sqladmin.googleapis.com/Instance'],
  'cloudkms.cryptoKeys': ['cloudkms.googleapis.com/CryptoKey'],
  'cloudkms.cryptoKeyVersions': ['cloudkms.googleapis.com/CryptoKey'],
  'iam.serviceAccounts': ['iam.googleapis.com/ServiceAccount'],
  'datastore.entities': ['firestore.googleapis.com/Database'],
  'datastore.databases': ['firestore.googleapis.com/Database'],
};
const TARGET_ASSET_TYPES = [...new Set(Object.values(PERMISSION_ASSET_TYPES).flat())];

function assetTypesForRole(role: string): string[] {
  const types = new Set<string>();
  for (const permission of raw.roles[role] ?? []) {
    const key = permission.split('.').slice(0, 2).join('.');
    for (const t of PERMISSION_ASSET_TYPES[key] ?? []) types.add(t);
  }
  return [...types];
}

type InventoryItem = { name: string; assetType: string; project: string; folders: string[]; organization: string };
type Access = { identity: string; resource: string; role: string };
const key = (a: Access) => `${a.identity}|${a.resource}|${a.role}`;

// ---- インベントリ（両方式で共通に使う: アセットタイプの判定と (a) の展開） ----
let start = performance.now();
const inventory: InventoryItem[] = [];
for await (const r of asset.searchAllResourcesAsync({ scope: SCOPE, assetTypes: TARGET_ASSET_TYPES, pageSize: 500 })) {
  inventory.push({
    name: r.name ?? '',
    assetType: r.assetType ?? '',
    project: r.project ?? '',
    folders: r.folders ?? [],
    organization: r.organization ?? '',
  });
}
const inventoryMs = Math.round(performance.now() - start);
const assetTypeByName = new Map(inventory.map((i) => [i.name, i.assetType]));

// //cloudresourcemanager.googleapis.com/projects/foo の foo（project ID）→ number の解決が必要
const projectNumberById = new Map<string, string>();
for await (const p of asset.searchAllResourcesAsync({ scope: SCOPE, assetTypes: ['cloudresourcemanager.googleapis.com/Project'] })) {
  projectNumberById.set(p.name?.split('/').pop() ?? '', p.project ?? '');
}

function underContainer(item: InventoryItem, grantedOn: string): boolean {
  const m = grantedOn.match(/^\/\/cloudresourcemanager\.googleapis\.com\/(projects|folders|organizations)\/([^/]+)$/);
  if (!m) return item.name === grantedOn;
  const [, kind, id] = m;
  if (kind === 'projects') return item.project === projectNumberById.get(id) || item.project === `projects/${id}`;
  if (kind === 'folders') return item.folders.includes(`folders/${id}`);
  return item.organization === `organizations/${id}`;
}

// ---- (a) 自前展開 ----
const hasRoleEdges = raw.edges.filter((e) => e.kind === 'HAS_ROLE');
start = performance.now();
const accessA: Access[] = [];
for (const e of hasRoleEdges) {
  const types = new Set(assetTypesForRole(e.role));
  if (types.size === 0) continue;
  for (const item of inventory) {
    if (types.has(item.assetType) && underContainer(item, e.grantedOn)) {
      accessA.push({ identity: e.from, resource: item.name, role: e.role });
    }
  }
}
const expandAMs = Math.round(performance.now() - start);

// ---- (b) ハイブリッド ----
const identities = [...new Set(hasRoleEdges.map((e) => e.from))];
const reachedSAs = identities.filter((i) => i.startsWith('serviceAccount:'));
const accessB: Access[] = accessA.filter((a) => !a.identity.startsWith('serviceAccount:'));
const analyzerStats: Record<string, { ms: number; rawResources: number; kept: number; error?: string }> = {};
start = performance.now();
for (const identity of process.env.SKIP_ANALYZER ? [] : reachedSAs) {
  const t = performance.now();
  try {
    const [res] = await asset.analyzeIamPolicy({
      analysisQuery: { scope: SCOPE, identitySelector: { identity }, options: { expandResources: true } },
      executionTimeout: { seconds: 60 },
    });
    let rawResources = 0;
    let kept = 0;
    for (const result of res.mainAnalysis?.analysisResults ?? []) {
      const role = result.iamBinding?.role ?? '';
      for (const acl of result.accessControlLists ?? []) {
        for (const r of acl.resources ?? []) {
          rawResources++;
          const name = r.fullResourceName ?? '';
          if (!assetTypeByName.has(name)) continue;
          kept++;
          accessB.push({ identity, resource: name, role });
        }
      }
    }
    analyzerStats[identity] = { ms: Math.round(performance.now() - t), rawResources, kept };
  } catch (e) {
    analyzerStats[identity] = { ms: Math.round(performance.now() - t), rawResources: 0, kept: 0, error: String(e) };
  }
}
const expandBMs = Math.round(performance.now() - start);

// ---- 比較 ----
const setA = new Map(accessA.map((a) => [key(a), a]));
const setB = new Map(accessB.map((a) => [key(a), a]));
const onlyA = [...setA.values()].filter((a) => !setB.has(key(a)));
const onlyB = [...setB.values()].filter((a) => !setA.has(key(a)));
const both = [...setA.keys()].filter((k) => setB.has(k)).length;

const countBy = <T>(xs: T[], f: (x: T) => string) =>
  xs.reduce<Record<string, number>>((acc, x) => ((acc[f(x)] = (acc[f(x)] ?? 0) + 1), acc), {});
const typeOf = (a: Access) => assetTypeByName.get(a.resource) ?? '?';

await writeFile(new URL('../out/expand.json', import.meta.url), JSON.stringify({ accessA: accessA.map((a) => ({ ...a, assetType: typeOf(a) })), onlyA, onlyB, analyzerStats }, null, 2));

console.log(`inventory: ${inventory.length} resources (${TARGET_ASSET_TYPES.length} types) in ${inventoryMs}ms`);
console.log(`(a) ${setA.size} accesses, expand ${expandAMs}ms (+ inventory)`);
console.log(`(b) ${setB.size} accesses, analyzer ${expandBMs}ms for ${reachedSAs.length} SAs`);
console.log(`both=${both} onlyA=${onlyA.length} onlyB=${onlyB.length}`);
console.log('\n# onlyA by assetType × role');
console.log(countBy(onlyA, (a) => `${typeOf(a)} ${a.role}`));
console.log('\n# onlyB by assetType × role');
console.log(countBy(onlyB, (a) => `${typeOf(a)} ${a.role}`));
console.log('\n# analyzer stats');
console.log(analyzerStats);
