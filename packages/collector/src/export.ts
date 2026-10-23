import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import {
  EXPANDABLE_ASSET_TYPES,
  ResourceInventory,
  isWifMember,
  type Container,
  type InventoryResource,
  type MemberBinding,
} from '@wif-viz/core';
import { CONTAINER_TYPES, CRM, buildSnapshot, toPool, toProvider, withOrganization, type CollectOptions, type CollectResult, type IamPool, type IamProvider } from './collect.ts';
import type { GcpClient } from './gcp.ts';

/**
 * `gcloud asset export` の 1 行（Asset）。
 * GCS に書き出したファイルは snake_case、API の応答は camelCase のため、読み込み時に揃える。
 */
export interface ExportedAsset {
  name: string;
  assetType: string;
  /** 自身（container の場合）と祖先。近い順に `projects/{number}` / `folders/{id}` / `organizations/{id}` */
  ancestors: string[];
  data?: Record<string, unknown>;
  iamPolicy?: { bindings?: { role?: string; members?: string[]; condition?: { expression?: string; title?: string } }[] };
}

type ContentKind = 'resource' | 'iam-policy';

export function parseExportedAsset(line: string): { kind: ContentKind; asset: ExportedAsset } | undefined {
  const raw = JSON.parse(line) as Record<string, unknown>;
  const name = raw.name;
  const assetType = raw.assetType ?? raw.asset_type;
  if (typeof name !== 'string' || typeof assetType !== 'string') return undefined;
  const ancestors = Array.isArray(raw.ancestors) ? raw.ancestors.filter((a): a is string => typeof a === 'string') : [];
  const iamPolicy = (raw.iamPolicy ?? raw.iam_policy) as ExportedAsset['iamPolicy'] | undefined;
  if (iamPolicy) return { kind: 'iam-policy', asset: { name, assetType, ancestors, iamPolicy } };
  const data = (raw.resource as { data?: Record<string, unknown> } | undefined)?.data;
  return { kind: 'resource', asset: { name, assetType, ancestors, ...(data ? { data } : {}) } };
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** org / folder / project のアセットを container に変換する。project は API の検索結果に合わせて project ID の名前にする */
export function toExportedContainer(asset: ExportedAsset): Container | undefined {
  const type = CONTAINER_TYPES[asset.assetType as keyof typeof CONTAINER_TYPES];
  if (!type) return undefined;
  const lastSegment = asset.name.split('/').pop()!;
  // ancestors[0] は自身、ancestors[1] が親
  const parent = asset.ancestors[1];
  const displayName = str(type === 'project' ? asset.data?.name : asset.data?.displayName);
  const id = type === 'project' ? (str(asset.data?.projectId) ?? lastSegment) : lastSegment;
  return {
    name: type === 'project' ? `${CRM}projects/${id}` : asset.name,
    type,
    id,
    ...(type === 'project' ? { projectNumber: str(asset.data?.projectNumber) ?? lastSegment } : {}),
    ...(displayName ? { displayName } : {}),
    ...(parent ? { parent: `${CRM}${parent}` } : {}),
  };
}

/** SA のアセット名（unique ID）を、API の検索結果と同じ email の名前に変換する */
export function serviceAccountNameOf(asset: ExportedAsset): string | undefined {
  const email = str(asset.data?.email);
  return email ? asset.name.replace(/\/serviceAccounts\/[^/]+$/, `/serviceAccounts/${email}`) : undefined;
}

export interface AssetExport {
  containers: Container[];
  inventory: ResourceInventory;
  pools: IamPool[];
  providers: IamProvider[];
  /** WIF principal と SA に付与されたバインディング（member ごと） */
  bindingsByMember: Map<string, MemberBinding[]>;
  /** エクスポートに含まれるカスタムロールの permission */
  customRoles: Map<string, string[]>;
}

export interface ReadExportOptions {
  orgId: string;
  log?: (message: string) => void;
}

async function listFiles(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? listFiles(join(path, e.name)) : Promise.resolve(e.isFile() ? [join(path, e.name)] : []))),
  );
  return nested.flat();
}

async function* readLines(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file);
  const lines = createInterface({ input: file.endsWith('.gz') ? stream.pipe(createGunzip()) : stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line.trim() !== '') yield line;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** ファイルの内容が resource と iam-policy のどちらかを、最初のアセットで判定する */
async function contentKindOf(file: string): Promise<ContentKind | undefined> {
  for await (const line of readLines(file)) return parseExportedAsset(line)?.kind;
  return undefined;
}

async function* readAssets(file: string, kind: ContentKind, orgId: string): AsyncGenerator<ExportedAsset> {
  const org = `organizations/${orgId}`;
  for await (const line of readLines(file)) {
    const parsed = parseExportedAsset(line);
    if (!parsed) continue;
    if (parsed.kind !== kind) throw new Error(`${file} に resource と iam-policy のエクスポートが混在しています。content-type ごとに別のファイルに書き出してください`);
    const root = parsed.asset.ancestors.at(-1);
    if (root && root !== org) throw new Error(`${file} は ${org} のエクスポートではありません（${root} のアセットを含みます）`);
    yield parsed.asset;
  }
}

const POOL = 'iam.googleapis.com/WorkloadIdentityPool';
const PROVIDER = 'iam.googleapis.com/WorkloadIdentityPoolProvider';
const SERVICE_ACCOUNT = 'iam.googleapis.com/ServiceAccount';
const EXPANDABLE = new Set<string>(EXPANDABLE_ASSET_TYPES);

/**
 * `gcloud asset export` で書き出したファイル（ディレクトリの場合は配下のすべてのファイル）を読み込む。
 * resource のファイルを先に読み、project と SA の名前を API の検索結果と同じ形に揃えてから iam-policy のファイルを読む。
 */
export async function readAssetExport(path: string, options: ReadExportOptions): Promise<AssetExport> {
  const log = options.log ?? (() => {});
  const files: Record<ContentKind, string[]> = { resource: [], 'iam-policy': [] };
  for (const file of await listFiles(path)) {
    const kind = await contentKindOf(file);
    if (kind) files[kind].push(file);
  }
  if (files.resource.length === 0) throw new Error(`${path} に resource のエクスポートがありません`);
  if (files['iam-policy'].length === 0) throw new Error(`${path} に iam-policy のエクスポートがありません`);

  log(`resource のエクスポート（${files.resource.length} ファイル）を読み込んでいます`);
  const containers: Container[] = [];
  const inventoryResources: InventoryResource[] = [];
  const pools: IamPool[] = [];
  const providers: IamProvider[] = [];
  const customRoles = new Map<string, string[]>();
  // エクスポートのアセット名 → API の検索結果での名前（project と SA）
  const renamed = new Map<string, string>();

  for (const file of files.resource) {
    for await (const asset of readAssets(file, 'resource', options.orgId)) {
      const container = toExportedContainer(asset);
      if (container) {
        containers.push(container);
        if (container.name !== asset.name) renamed.set(asset.name, container.name);
        continue;
      }
      if (asset.assetType === POOL || asset.assetType === PROVIDER) {
        const data = { name: asset.name.replace('//iam.googleapis.com/', ''), ...asset.data };
        (asset.assetType === POOL ? pools : providers).push(data);
        continue;
      }
      if (asset.assetType === 'iam.googleapis.com/Role') {
        const name = str(asset.data?.name);
        const permissions = asset.data?.includedPermissions;
        if (name) customRoles.set(name, Array.isArray(permissions) ? permissions.filter((p): p is string => typeof p === 'string') : []);
        continue;
      }
      if (!EXPANDABLE.has(asset.assetType)) continue;
      let name = asset.name;
      if (asset.assetType === SERVICE_ACCOUNT) {
        name = serviceAccountNameOf(asset) ?? name;
        if (name !== asset.name) renamed.set(asset.name, name);
      }
      inventoryResources.push({ name, assetType: asset.assetType, ancestors: asset.ancestors });
    }
  }

  const allContainers = withOrganization(containers, options.orgId);
  const inventory = new ResourceInventory(allContainers, inventoryResources);
  inventoryResources.length = 0;
  log(`container ${allContainers.length} 件、インベントリ ${inventory.size} 件、カスタムロール ${customRoles.size} 件`);

  log(`iam-policy のエクスポート（${files['iam-policy'].length} ファイル）を読み込んでいます`);
  const bindingsByMember = new Map<string, MemberBinding[]>();
  let bindingCount = 0;
  for (const file of files['iam-policy']) {
    for await (const asset of readAssets(file, 'iam-policy', options.orgId)) {
      const resource = renamed.get(asset.name) ?? asset.name;
      for (const b of asset.iamPolicy?.bindings ?? []) {
        if (!b.role) continue;
        const condition = b.condition?.expression ? { condition: { expression: b.condition.expression, ...(b.condition.title ? { title: b.condition.title } : {}) } } : {};
        for (const member of b.members ?? []) {
          // 探索で問い合わせるのは SA と WIF principal だけ
          if (!member.startsWith('serviceAccount:') && !isWifMember(member)) continue;
          const list = bindingsByMember.get(member) ?? [];
          list.push({ resource, role: b.role, member, ...condition });
          bindingsByMember.set(member, list);
          bindingCount++;
        }
      }
    }
  }
  log(`SA と WIF principal へのバインディング ${bindingCount} 件`);

  return { containers: allContainers, inventory, pools, providers, bindingsByMember, customRoles };
}

/** Provider の種類（oidc / aws など）が data にない場合は、エクスポートだけでは詳細が足りない */
const isCompleteProvider = (provider: IamProvider) => !!(provider.oidc || provider.aws || provider.saml || provider.x509);

/**
 * エクスポートから収集する。IAM のバインディングは API を呼ばずに索引から引く。
 * API を呼ぶのは、predefined ロール（とエクスポートにないカスタムロール）の定義と、詳細が足りない Provider だけ。
 */
export async function collectSnapshotFromExport(exportPath: string, gcp: GcpClient, options: CollectOptions): Promise<CollectResult> {
  const exported = await readAssetExport(exportPath, options);

  const providers = await Promise.all(
    exported.providers.map(async (provider) => (isCompleteProvider(provider) ? provider : ((await gcp.iamGet<IamProvider>(provider.name)) ?? provider))),
  );

  return buildSnapshot(
    {
      containers: exported.containers,
      inventory: exported.inventory,
      pools: exported.pools.map(toPool),
      providers: providers.map(toProvider),
      wifBindings: [...exported.bindingsByMember].filter(([member]) => isWifMember(member)).flatMap(([, bindings]) => bindings),
      bindingsForMember: async (member) => exported.bindingsByMember.get(member) ?? [],
      rolePermissions: async (role) => exported.customRoles.get(role) ?? (await gcp.iamGet<{ includedPermissions?: string[] }>(role))?.includedPermissions,
    },
    options,
  );
}

/** resource のエクスポートに含めるアセットタイプ（container、WIF、カスタムロール、展開対象） */
export const RESOURCE_EXPORT_ASSET_TYPES: readonly string[] = [...Object.keys(CONTAINER_TYPES), POOL, PROVIDER, 'iam.googleapis.com/Role', ...EXPANDABLE_ASSET_TYPES];

export interface ExportCommandsOptions {
  orgId: string;
  /** 書き出し先の GCS のプレフィックス（gs://<bucket>/<path>） */
  destination: string;
  billingProject?: string;
  /** ダウンロード先のディレクトリ */
  localDir: string;
}

/** `collect --from-export` の入力を作る gcloud コマンド */
export function exportCommands(options: ExportCommandsOptions): string[] {
  const destination = options.destination.replace(/\/+$/, '');
  const billing = options.billingProject ? ` --billing-project=${options.billingProject}` : '';
  return [
    `gcloud asset export --organization=${options.orgId} --content-type=resource --asset-types=${RESOURCE_EXPORT_ASSET_TYPES.join(',')} --output-path=${destination}/resource.json${billing}`,
    `gcloud asset export --organization=${options.orgId} --content-type=iam-policy --output-path=${destination}/iam-policy.json${billing}`,
    `gcloud storage cp '${destination}/*.json' ${options.localDir}/`,
  ];
}
