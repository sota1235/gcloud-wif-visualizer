import type { FullResourceName, Member, PrincipalNode } from './types.ts';

const PRINCIPAL_PATTERN =
  /^(principal|principalSet):\/\/iam\.googleapis\.com\/projects\/(\d+)\/locations\/global\/workloadIdentityPools\/([^/]+)\/(.+)$/;

/** WIF の principal / principalSet の member 文字列を解析する。WIF 以外は undefined */
export function parseWifPrincipal(member: Member): PrincipalNode | undefined {
  const match = member.match(PRINCIPAL_PATTERN);
  if (!match) return undefined;
  const [, scheme, projectNumber, poolId, rest] = match as unknown as [string, string, string, string, string];
  // GKE 用の Workload Identity Federation（{project}.svc.id.goog）は対象外
  if (poolId.endsWith('.svc.id.goog')) return undefined;
  const base = {
    kind: 'principal' as const,
    id: member,
    projectNumber,
    poolId,
    poolName: `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}`,
  };

  if (scheme === 'principal') {
    return rest.startsWith('subject/') ? { ...base, principalKind: 'subject', value: rest.slice('subject/'.length) } : undefined;
  }
  if (rest === '*') return { ...base, principalKind: 'all' };
  if (rest.startsWith('group/')) return { ...base, principalKind: 'group', value: rest.slice('group/'.length) };
  // attribute の値にはスラッシュが含まれ得る（例: attribute.repository/org/repo）
  const attr = rest.match(/^attribute\.([^/]+)\/(.+)$/);
  if (attr) return { ...base, principalKind: 'attribute', attributeKey: attr[1], value: attr[2] };
  return undefined;
}

export function isWifMember(member: Member): boolean {
  return parseWifPrincipal(member) !== undefined;
}

const SERVICE_ACCOUNT_RESOURCE = /^\/\/iam\.googleapis\.com\/projects\/[^/]+\/serviceAccounts\/([^/]+)$/;

/** SA のリソース名から email を取り出す。SA 以外は undefined */
export function serviceAccountEmailFromResource(resource: FullResourceName): string | undefined {
  const value = resource.match(SERVICE_ACCOUNT_RESOURCE)?.[1];
  // unique ID でのリソース名もあり得るが、email 形式のみ扱う
  return value?.includes('@') ? value : undefined;
}

export function serviceAccountMember(email: string): Member {
  return `serviceAccount:${email}`;
}

export function serviceAccountEmailFromMember(member: Member): string | undefined {
  return member.startsWith('serviceAccount:') ? member.slice('serviceAccount:'.length) : undefined;
}

const CONTAINER_RESOURCE = /^\/\/cloudresourcemanager\.googleapis\.com\/(projects|folders|organizations)\/[^/]+$/;

export function isContainerResource(resource: FullResourceName): boolean {
  return CONTAINER_RESOURCE.test(resource);
}

/** 決定的な短いハッシュ（FNV-1a 32bit）。ID の一部に使う */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** ID の構成要素を連結する。condition など長い値はハッシュにする */
export function edgeId(kind: string, from: string, to: string, ...extra: (string | undefined)[]): string {
  const suffix = extra.map((e) => (e === undefined ? '' : e.length > 64 ? stableHash(e) : e));
  return [kind, from, to, ...suffix].join('|');
}
