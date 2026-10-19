// PoC: Org 全体から WIF の設定と到達可能な権限を収集し、API の挙動と規模感を検証する
import { mkdir, writeFile } from 'node:fs/promises';
import { AssetServiceClient } from '@google-cloud/asset';
import { GoogleAuth } from 'google-auth-library';

const ORG_ID = process.env.ORG_ID;
const MAX_DEPTH = Number(process.env.MAX_DEPTH ?? 5);
if (!ORG_ID) throw new Error('ORG_ID を指定してください');
const SCOPE = `organizations/${ORG_ID}`;

const IMPERSONATION_PERMISSIONS = new Set([
  'iam.serviceAccounts.getAccessToken',
  'iam.serviceAccounts.getOpenIdToken',
  'iam.serviceAccounts.signJwt',
  'iam.serviceAccounts.signBlob',
]);
const ACT_AS_PERMISSION = 'iam.serviceAccounts.actAs';

const asset = new AssetServiceClient();
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

type Binding = {
  resource: string;
  assetType: string;
  role: string;
  member: string;
  condition?: string;
};

const timings: Record<string, number> = {};
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[label] = (timings[label] ?? 0) + Math.round(performance.now() - start);
  }
}

async function iamGet<T>(path: string): Promise<T> {
  const client = await auth.getClient();
  const res = await client.request<T>({ url: `https://iam.googleapis.com/v1/${path}` });
  return res.data;
}

async function searchResources(scope: string, assetTypes: string[]) {
  const results = [];
  for await (const r of asset.searchAllResourcesAsync({ scope, assetTypes, pageSize: 500 })) {
    results.push(r);
  }
  return results;
}

async function searchBindings(query: string, memberFilter: (m: string) => boolean): Promise<Binding[]> {
  const bindings: Binding[] = [];
  for await (const r of asset.searchAllIamPoliciesAsync({ scope: SCOPE, query, pageSize: 500 })) {
    for (const b of r.policy?.bindings ?? []) {
      for (const member of b.members ?? []) {
        if (!memberFilter(member)) continue;
        bindings.push({
          resource: r.resource ?? '',
          assetType: r.assetType ?? '',
          role: b.role ?? '',
          member,
          condition: b.condition?.expression ?? undefined,
        });
      }
    }
  }
  return bindings;
}

const roleCache = new Map<string, string[]>();
async function rolePermissions(role: string): Promise<string[]> {
  const cached = roleCache.get(role);
  if (cached) return cached;
  const data = await timed('roles.get', () => iamGet<{ includedPermissions?: string[] }>(role));
  const permissions = data.includedPermissions ?? [];
  roleCache.set(role, permissions);
  return permissions;
}

// //cloudresourcemanager.googleapis.com/projects/foo → projects/foo
function containerScope(resource: string): string | undefined {
  const m = resource.match(/^\/\/cloudresourcemanager\.googleapis\.com\/((?:projects|folders|organizations)\/[^/]+)$/);
  return m?.[1];
}

function serviceAccountEmail(resource: string): string | undefined {
  return resource.match(/\/serviceAccounts\/([^/]+@[^/]+)$/)?.[1];
}

const saCache = new Map<string, string[]>();
async function serviceAccountsUnder(scope: string): Promise<string[]> {
  const cached = saCache.get(scope);
  if (cached) return cached;
  const sas = await timed('searchAllResources(SA)', () =>
    searchResources(scope, ['iam.googleapis.com/ServiceAccount']),
  );
  const emails = sas.map((r) => serviceAccountEmail(r.name ?? '')).filter((e): e is string => !!e);
  saCache.set(scope, emails);
  return emails;
}

// binding の付与先から、権限が及ぶ SA の一覧を求める
async function targetServiceAccounts(b: Binding): Promise<string[]> {
  const email = serviceAccountEmail(b.resource);
  if (email) return [email];
  const scope = containerScope(b.resource);
  return scope ? serviceAccountsUnder(scope) : [];
}

type Edge = { from: string; to: string; kind: 'CAN_IMPERSONATE' | 'CAN_ACT_AS' | 'HAS_ROLE'; role: string; grantedOn: string; condition?: string };

async function main() {
  // 1. 組織構造（project number → id）
  const projects = await timed('searchAllResources(Project)', () =>
    searchResources(SCOPE, ['cloudresourcemanager.googleapis.com/Project']),
  );
  const projectIdByNumber = new Map(
    projects.map((p) => [p.project?.replace('projects/', '') ?? '', p.name?.split('/').pop() ?? '']),
  );

  // 2. WIF 設定
  const wifAssets = await timed('searchAllResources(WIF)', () =>
    searchResources(SCOPE, ['iam.googleapis.com/WorkloadIdentityPool', 'iam.googleapis.com/WorkloadIdentityPoolProvider']),
  );
  const providers = await Promise.all(
    wifAssets
      .filter((a) => a.assetType === 'iam.googleapis.com/WorkloadIdentityPoolProvider')
      .map((a) => timed('providers.get', () => iamGet<Record<string, unknown>>((a.name ?? '').replace('//iam.googleapis.com/', '')))),
  );
  const pools = wifAssets.filter((a) => a.assetType === 'iam.googleapis.com/WorkloadIdentityPool').map((a) => a.name);

  // 3. 起点のバインディング（WIF principal）
  const isWifMember = (m: string) => m.includes('/workloadIdentityPools/');
  const wifBindings = await timed('searchAllIamPolicies(WIF)', () =>
    searchBindings('policy:workloadIdentityPools', isWifMember),
  );

  // 4. impersonation の探索（BFS）
  const edges: Edge[] = [];
  const visited = new Set<string>();
  let frontier: { identity: string; bindings: Binding[]; depth: number }[] = [];
  const principals = [...new Set(wifBindings.map((b) => b.member))];
  for (const p of principals) frontier.push({ identity: p, bindings: wifBindings.filter((b) => b.member === p), depth: 0 });

  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { identity, bindings, depth } of frontier) {
      for (const b of bindings) {
        const permissions = await rolePermissions(b.role);
        const canImpersonate = permissions.some((p) => IMPERSONATION_PERMISSIONS.has(p));
        const canActAs = permissions.includes(ACT_AS_PERMISSION);
        const base = { from: identity, role: b.role, grantedOn: b.resource, condition: b.condition };

        if (!serviceAccountEmail(b.resource)) edges.push({ ...base, kind: 'HAS_ROLE', to: b.resource });
        if (!canImpersonate && !canActAs) continue;

        for (const sa of await targetServiceAccounts(b)) {
          const saMember = `serviceAccount:${sa}`;
          if (canActAs) edges.push({ ...base, kind: 'CAN_ACT_AS', to: saMember });
          if (!canImpersonate) continue;
          edges.push({ ...base, kind: 'CAN_IMPERSONATE', to: saMember });
          if (visited.has(saMember) || depth + 1 > MAX_DEPTH) continue;
          visited.add(saMember);
          const saBindings = await timed('searchAllIamPolicies(SA)', () =>
            searchBindings(`policy:"${saMember}"`, (m) => m === saMember),
          );
          next.push({ identity: saMember, bindings: saBindings, depth: depth + 1 });
        }
      }
    }
    frontier = next;
  }

  // 5. Policy Analyzer の検証（principalSet と SA でそれぞれ試す）
  const analyzerResults: Record<string, { results: number; resources: number; ms: number; error?: string }> = {};
  const analyzerTargets = [...principals.slice(0, 1), ...[...visited].slice(0, 2)];
  for (const identity of analyzerTargets) {
    const start = performance.now();
    try {
      const [res] = await asset.analyzeIamPolicy({
        analysisQuery: { scope: SCOPE, identitySelector: { identity }, options: { expandResources: true } },
      });
      const results = res.mainAnalysis?.analysisResults ?? [];
      const resources = results.flatMap((r) => r.accessControlLists ?? []).flatMap((acl) => acl.resources ?? []);
      analyzerResults[identity] = { results: results.length, resources: resources.length, ms: Math.round(performance.now() - start) };
    } catch (e) {
      analyzerResults[identity] = { results: 0, resources: 0, ms: Math.round(performance.now() - start), error: String(e) };
    }
  }

  // 6. 規模感（Org 全体のリソース数）
  let totalResources = 0;
  await timed('searchAllResources(all, count)', async () => {
    for await (const _ of asset.searchAllResourcesAsync({ scope: SCOPE, pageSize: 500 })) totalResources++;
  });

  const out = { collectedAt: new Date().toISOString(), org: ORG_ID, projects: projects.length, projectIdByNumber: Object.fromEntries(projectIdByNumber), pools, providers, wifBindings, edges, roles: Object.fromEntries(roleCache), analyzerResults, totalResources, timings };
  await mkdir(new URL('../out/', import.meta.url), { recursive: true });
  await writeFile(new URL('../out/raw.json', import.meta.url), JSON.stringify(out, null, 2));

  console.log(`projects=${projects.length} pools=${pools.length} providers=${providers.length} wifBindings=${wifBindings.length} totalResources=${totalResources}`);
  console.log('\n# providers');
  for (const p of providers) {
    console.log(`- ${p.name}\n  issuer=${(p.oidc as { issuerUri?: string })?.issuerUri}\n  mapping=${JSON.stringify(p.attributeMapping)}\n  condition=${p.attributeCondition ?? '(none)'}`);
  }
  console.log('\n# edges');
  for (const e of edges) console.log(`- [${e.kind}] ${e.from}\n    → ${e.to} (${e.role})${e.condition ? ` if ${e.condition}` : ''}`);
  console.log('\n# policy analyzer');
  console.log(analyzerResults);
  console.log('\n# timings(ms)');
  console.log(timings);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
