import {
  EXPANDABLE_ASSET_TYPES,
  buildAccessGraph,
  computeEffectiveAccess,
  containerKey,
  ResourceInventory,
  createSnapshot,
  explore,
  isWifMember,
  serviceAccountEmailFromMember,
  serviceAccountEmailFromResource,
  type AccessSource,
  type Container,
  type InventoryResource,
  type MemberBinding,
  type ProviderKind,
  type Snapshot,
  type WorkloadIdentityPool,
  type WorkloadIdentityPoolProvider,
} from '@wif-viz/core';
import type { protos } from '@google-cloud/asset';
import type { GcpClient } from './gcp.ts';

type ResourceSearchResult = protos.google.cloud.asset.v1.IResourceSearchResult;
type IamPolicySearchResult = protos.google.cloud.asset.v1.IIamPolicySearchResult;

export interface CollectOptions {
  orgId: string;
  maxDepth: number;
  /** 進捗の出力先 */
  log?: (message: string) => void;
}

export interface CollectResult {
  snapshot: Snapshot;
  inventory: ResourceInventory;
  /** 収集は続行したが注意が必要な事象（ロール定義が取得できなかったなど） */
  warnings: string[];
}

export const CRM = '//cloudresourcemanager.googleapis.com/';
export const CONTAINER_TYPES = {
  'cloudresourcemanager.googleapis.com/Organization': 'organization',
  'cloudresourcemanager.googleapis.com/Folder': 'folder',
  'cloudresourcemanager.googleapis.com/Project': 'project',
} as const;

// ---- API レスポンスの変換（純粋関数） ----

export function toContainer(r: ResourceSearchResult): Container | undefined {
  const type = CONTAINER_TYPES[r.assetType as keyof typeof CONTAINER_TYPES];
  if (!type || !r.name) return undefined;
  const id = r.name.split('/').pop()!;
  return {
    name: r.name,
    type,
    id,
    ...(type === 'project' && r.project ? { projectNumber: r.project.replace('projects/', '') } : {}),
    ...(r.displayName ? { displayName: r.displayName } : {}),
    ...(r.parentFullResourceName?.startsWith(CRM) ? { parent: r.parentFullResourceName } : {}),
  };
}

export function toInventoryResource(r: ResourceSearchResult): InventoryResource | undefined {
  if (!r.name || !r.assetType) return undefined;
  const ancestors = [r.project, ...(r.folders ?? []), r.organization].filter((a): a is string => !!a);
  return { name: r.name, assetType: r.assetType, ancestors };
}

export function toMemberBindings(results: IamPolicySearchResult[], memberFilter: (member: string) => boolean): MemberBinding[] {
  const bindings: MemberBinding[] = [];
  for (const r of results) {
    for (const b of r.policy?.bindings ?? []) {
      for (const member of b.members ?? []) {
        if (!r.resource || !b.role || !memberFilter(member)) continue;
        bindings.push({
          resource: r.resource,
          role: b.role,
          member,
          ...(b.condition?.expression ? { condition: { expression: b.condition.expression, ...(b.condition.title ? { title: b.condition.title } : {}) } } : {}),
        });
      }
    }
  }
  return bindings;
}

export interface IamPool {
  name: string;
  displayName?: string;
  state?: string;
  disabled?: boolean;
}

export interface IamProvider extends IamPool {
  attributeMapping?: Record<string, string>;
  attributeCondition?: string;
  oidc?: { issuerUri?: string; allowedAudiences?: string[] };
  aws?: unknown;
  saml?: unknown;
  x509?: unknown;
}

export function toPool(pool: IamPool): WorkloadIdentityPool {
  const [, projectNumber = '', , , , poolId = ''] = pool.name.split('/');
  return {
    name: pool.name,
    projectNumber,
    poolId,
    ...(pool.displayName ? { displayName: pool.displayName } : {}),
    disabled: pool.disabled === true || pool.state === 'DELETED',
  };
}

export function toProvider(provider: IamProvider): WorkloadIdentityPoolProvider {
  const kind: ProviderKind = provider.oidc ? 'oidc' : provider.aws ? 'aws' : provider.saml ? 'saml' : provider.x509 ? 'x509' : 'unknown';
  return {
    name: provider.name,
    poolName: provider.name.replace(/\/providers\/[^/]+$/, ''),
    providerId: provider.name.split('/').pop()!,
    kind,
    ...(provider.oidc?.issuerUri ? { issuerUri: provider.oidc.issuerUri } : {}),
    ...(provider.oidc?.allowedAudiences ? { allowedAudiences: provider.oidc.allowedAudiences } : {}),
    attributeMapping: provider.attributeMapping ?? {},
    ...(provider.attributeCondition ? { attributeCondition: provider.attributeCondition } : {}),
    disabled: provider.disabled === true || provider.state === 'DELETED',
  };
}

/**
 * 存在チェックの対象にする SA を決める。インベントリにない SA のうち、Org 内の project に属するもの
 * （`{projectId}.iam.gserviceaccount.com`）だけを「存在しない」とみなし、Google 管理の SA や他の Org の SA は存在するものとして扱う。
 */
export function existingServiceAccountsOf(
  explored: { bindings: MemberBinding[]; depth: Map<string, number>; serviceAccountEdges: { from: string; to: string }[] },
  serviceAccountInventory: InventoryResource[],
  containers: Container[],
): Set<string> {
  const inventoryEmails = new Set(serviceAccountInventory.map((r) => serviceAccountEmailFromResource(r.name)).filter((e): e is string => e !== undefined));
  const orgProjectIds = new Set(containers.filter((c) => c.type === 'project').map((c) => c.id));
  const members = [
    ...explored.depth.keys(),
    ...explored.serviceAccountEdges.flatMap((e) => [e.from, e.to]),
    ...explored.bindings.map((b) => b.member),
    ...explored.bindings.map((b) => serviceAccountEmailFromResource(b.resource)).filter((e) => e !== undefined).map((e) => `serviceAccount:${e}`),
  ];
  const existing = new Set(inventoryEmails);
  for (const email of members.map(serviceAccountEmailFromMember)) {
    if (!email || existing.has(email)) continue;
    const projectId = email.match(/@([^.]+)\.iam\.gserviceaccount\.com$/)?.[1];
    if (!projectId || !orgProjectIds.has(projectId)) existing.add(email);
  }
  return existing;
}

// ---- 収集 ----

/** 収集方法（API / エクスポート）によらず、探索とスナップショットの作成に使うデータ */
export interface OrgData {
  containers: Container[];
  inventory: ResourceInventory;
  pools: WorkloadIdentityPool[];
  providers: WorkloadIdentityPoolProvider[];
  /** WIF principal に付与されたバインディング（探索の起点） */
  wifBindings: MemberBinding[];
  /** WIF principal 以外の member（SA）に付与されたバインディング */
  bindingsForMember(member: string): Promise<MemberBinding[]>;
  /** ロールに含まれる permission。定義が見つからない場合は undefined */
  rolePermissions(role: string): Promise<string[] | undefined>;
}

const CRM_ORGANIZATIONS = `${CRM}organizations/`;

/** Organization はアセットとして取得できない場合があるため補う */
export function withOrganization(containers: Container[], orgId: string): Container[] {
  const name = `${CRM_ORGANIZATIONS}${orgId}`;
  return containers.some((c) => c.name === name) ? containers : [...containers, { name, type: 'organization', id: orgId }];
}

export async function collectSnapshot(gcp: GcpClient, options: CollectOptions): Promise<CollectResult> {
  const log = options.log ?? (() => {});
  const scope = `organizations/${options.orgId}`;

  log('組織構造とリソースのインベントリを取得しています');
  const [containerResults, wifResults, inventoryResults, wifPolicyResults] = await Promise.all([
    gcp.searchResources(scope, Object.keys(CONTAINER_TYPES), toContainer),
    gcp.searchResources(scope, ['iam.googleapis.com/WorkloadIdentityPool', 'iam.googleapis.com/WorkloadIdentityPoolProvider'], (r) => r),
    gcp.searchResources(scope, [...EXPANDABLE_ASSET_TYPES], toInventoryResource),
    gcp.searchIamPolicies(scope, 'policy:workloadIdentityPools'),
  ]);

  const containers = withOrganization(containerResults, options.orgId);
  const inventory = new ResourceInventory(containers, inventoryResults);
  inventoryResults.length = 0;
  log(`container ${containers.length} 件、インベントリ ${inventory.size} 件`);

  log('WIF の Pool / Provider の詳細を取得しています');
  const iamPath = (name: string | null | undefined) => (name ?? '').replace('//iam.googleapis.com/', '');
  const [pools, providers] = await Promise.all([
    Promise.all(wifResults.filter((r) => r.assetType === 'iam.googleapis.com/WorkloadIdentityPool').map((r) => gcp.iamGet<IamPool>(iamPath(r.name)))),
    Promise.all(wifResults.filter((r) => r.assetType === 'iam.googleapis.com/WorkloadIdentityPoolProvider').map((r) => gcp.iamGet<IamProvider>(iamPath(r.name)))),
  ]);

  return buildSnapshot(
    {
      containers,
      inventory,
      pools: pools.filter((p): p is IamPool => p !== undefined).map(toPool),
      providers: providers.filter((p): p is IamProvider => p !== undefined).map(toProvider),
      wifBindings: toMemberBindings(wifPolicyResults, isWifMember),
      bindingsForMember: async (member) => toMemberBindings(await gcp.searchIamPolicies(scope, `policy:"${member}"`), (m) => m === member),
      rolePermissions: async (role) => (await gcp.iamGet<{ includedPermissions?: string[] }>(role))?.includedPermissions,
    },
    options,
  );
}

/** WIF principal から権限の経路を探索し、スナップショットを作る */
export async function buildSnapshot(data: OrgData, options: CollectOptions): Promise<CollectResult> {
  const log = options.log ?? (() => {});
  const warnings: string[] = [];
  const { containers, inventory } = data;
  log(`Pool ${data.pools.length} 件、Provider ${data.providers.length} 件`);

  // ---- AccessSource の実装 ----
  const principals = [...new Set(data.wifBindings.map((b) => b.member))].sort();
  const bindingsCache = new Map<string, Promise<MemberBinding[]>>();
  const rolesCache = new Map<string, Promise<string[]>>();
  const containersByName = new Map(containers.map((c) => [c.name, c]));
  const serviceAccountInventory = [...inventory].filter((r) => r.assetType === 'iam.googleapis.com/ServiceAccount');

  const source: AccessSource = {
    bindingsForMember(member) {
      let cached = bindingsCache.get(member);
      if (!cached) {
        cached = isWifMember(member) ? Promise.resolve(data.wifBindings.filter((b) => b.member === member)) : data.bindingsForMember(member);
        bindingsCache.set(member, cached);
      }
      return cached;
    },
    rolePermissions(role) {
      let cached = rolesCache.get(role);
      if (!cached) {
        cached = data.rolePermissions(role).then((permissions) => {
          if (!permissions) warnings.push(`ロール ${role} の定義を取得できませんでした（permission なしとして扱います）`);
          return permissions ?? [];
        });
        rolesCache.set(role, cached);
      }
      return cached;
    },
    async serviceAccountsUnder(container) {
      const target = containersByName.get(container);
      if (!target) return [];
      const key = containerKey(target);
      return serviceAccountInventory
        .filter((r) => r.ancestors.includes(key))
        .map((r) => serviceAccountEmailFromResource(r.name))
        .filter((e): e is string => e !== undefined);
    },
  };

  log(`${principals.length} 個の WIF principal から権限の経路を探索しています`);
  const explored = await explore(principals, source, { maxDepth: options.maxDepth });
  if (explored.truncated.size > 0) warnings.push(`maxDepth（${options.maxDepth}）に達したため ${explored.truncated.size} 個の SA の先を探索していません`);

  // 実効アクセスの算出に、出現したすべてのロールの permission が必要
  const roleNames = [...new Set(explored.bindings.map((b) => b.role))].sort();
  const rolePermissions = Object.fromEntries(await Promise.all(roleNames.map(async (role) => [role, await source.rolePermissions(role)] as const)));

  const existingServiceAccounts = existingServiceAccountsOf(explored, serviceAccountInventory, containers);
  const graph = buildAccessGraph({ pools: data.pools, providers: data.providers, containers, explored, existingServiceAccounts });
  const effectiveAccess = computeEffectiveAccess(graph, { rolePermissions, assetTypeOf: (name) => inventory.get(name)?.assetType });
  log(`ノード ${graph.nodes.size} 件、エッジ ${graph.edges.size} 件、実効アクセス ${effectiveAccess.length} 件`);

  const org = containersByName.get(`${CRM_ORGANIZATIONS}${options.orgId}`);
  return {
    snapshot: createSnapshot({
      org: { id: options.orgId, ...(org?.displayName ? { displayName: org.displayName } : {}) },
      collectedAt: new Date(),
      options: { maxDepth: options.maxDepth },
      roles: rolePermissions,
      graph,
      effectiveAccess,
      inventory,
    }),
    inventory,
    warnings,
  };
}
