import type { Container, EffectiveAccess, Finding, FullResourceName, Member, Snapshot } from '@wif-viz/core';

/**
 * project での絞り込み方。
 * - reach: 選んだ project（または配下のリソース）のいずれかに WIF 経由で権限が届く
 * - pool: 選んだ project のいずれかに定義された WIF Pool を使う
 */
export type ProjectFilterMode = 'reach' | 'pool';

export interface ProjectFilter {
  projects: Container[];
  mode: ProjectFilterMode;
}

const CRM = '//cloudresourcemanager.googleapis.com';

type SnapshotPart = Pick<Snapshot, 'nodes' | 'effectiveAccess' | 'targetResources'>;

export function projectsOf(snapshot: Pick<Snapshot, 'nodes'>): Container[] {
  return snapshot.nodes
    .flatMap((n) => (n.kind === 'container' && n.container.type === 'project' ? [n.container] : []))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function containerMap(snapshot: Pick<Snapshot, 'nodes'>): Map<FullResourceName, Container> {
  return new Map(snapshot.nodes.flatMap((n) => (n.kind === 'container' ? [[n.id, n.container] as const] : [])));
}

/** container とその祖先の full resource name */
function selfAndAncestors(containers: Map<FullResourceName, Container>, name: FullResourceName): Set<FullResourceName> {
  const result = new Set<FullResourceName>();
  for (let current: FullResourceName | undefined = name; current && !result.has(current); current = containers.get(current)?.parent) result.add(current);
  return result;
}

/** リソース名に含まれる `projects/{id または number}` */
function projectSegmentOf(resource: FullResourceName): string | undefined {
  return /\/projects\/([^/]+)/.exec(resource)?.[1];
}

/** 選んだ project の集合を、付与先や Pool の照合に使う形にしたもの */
interface ProjectScope {
  names: Set<FullResourceName>;
  /** 選んだ project とその祖先の container */
  selfAndAncestors: Set<FullResourceName>;
  /** project ID と project number（リソース名や SA の email に含まれる） */
  ids: Set<string>;
  numbers: Set<string>;
}

function scopeOf(snapshot: Pick<Snapshot, 'nodes'>, projects: Container[]): ProjectScope {
  const containers = containerMap(snapshot);
  const numbers = new Set(projects.flatMap((p) => (p.projectNumber ? [p.projectNumber] : [])));
  return {
    names: new Set(projects.map((p) => p.name)),
    selfAndAncestors: new Set(projects.flatMap((p) => [...selfAndAncestors(containers, p.name)])),
    ids: new Set([...projects.map((p) => p.id), ...numbers]),
    numbers,
  };
}

/** 実効アクセスの付与先が、選んだ project（祖先の container を含む）または配下のリソースか */
function reachesScope(row: Pick<EffectiveAccess, 'grantedOn' | 'grantedOnKind'>, scope: ProjectScope, snapshot: SnapshotPart): boolean {
  if (row.grantedOnKind === 'container') return scope.selfAndAncestors.has(row.grantedOn);
  const target = snapshot.targetResources[row.grantedOn];
  if (target) return target.ancestors.some((a) => scope.names.has(a));
  const segment = projectSegmentOf(row.grantedOn);
  return segment !== undefined && scope.ids.has(segment);
}

/** 絞り込みの条件に当てはまる WIF principal */
export function principalsForProjects(snapshot: SnapshotPart, filter: ProjectFilter): Set<Member> {
  const scope = scopeOf(snapshot, filter.projects);
  if (filter.mode === 'pool') {
    return new Set(snapshot.nodes.flatMap((n) => (n.kind === 'principal' && scope.numbers.has(n.projectNumber) ? [n.id] : [])));
  }
  return new Set(snapshot.effectiveAccess.filter((row) => reachesScope(row, scope, snapshot)).map((row) => row.principal));
}

/** 絞り込みの候補にする project（その方法で 1 つ以上の principal が当てはまるもの） */
export function candidateProjects(snapshot: SnapshotPart, mode: ProjectFilterMode): Container[] {
  const projects = projectsOf(snapshot);
  if (mode === 'pool') {
    const numbers = new Set(snapshot.nodes.flatMap((n) => (n.kind === 'principal' ? [n.projectNumber] : [])));
    return projects.filter((p) => p.projectNumber !== undefined && numbers.has(p.projectNumber));
  }
  const grantedContainers = new Set<FullResourceName>();
  const resourceProjects = new Set<string>();
  for (const row of snapshot.effectiveAccess) {
    if (row.grantedOnKind === 'container') {
      grantedContainers.add(row.grantedOn);
      continue;
    }
    const target = snapshot.targetResources[row.grantedOn];
    if (target) target.ancestors.forEach((a) => resourceProjects.add(a));
    else {
      const segment = projectSegmentOf(row.grantedOn);
      if (segment) resourceProjects.add(segment);
    }
  }
  const containers = containerMap(snapshot);
  return projects.filter(
    (p) =>
      resourceProjects.has(p.name) ||
      resourceProjects.has(p.id) ||
      (p.projectNumber !== undefined && resourceProjects.has(p.projectNumber)) ||
      [...selfAndAncestors(containers, p.name)].some((c) => grantedContainers.has(c)),
  );
}

/**
 * SA の member / email が属する project の ID または number。
 * - `{name}@{projectId}.iam.gserviceaccount.com`（ユーザーが作成した SA）
 * - `{projectNumber}-compute@developer.gserviceaccount.com`（Compute Engine のデフォルト SA）
 * - `{projectId}@appspot.gserviceaccount.com`（App Engine のデフォルト SA）
 */
function serviceAccountProjectOf(member: string): string | undefined {
  const email = member.replace(/^serviceAccount:/, '');
  return (
    /@([^.@]+)\.iam\.gserviceaccount\.com$/.exec(email)?.[1] ??
    /^(\d+)-compute@developer\.gserviceaccount\.com$/.exec(email)?.[1] ??
    /^([^@]+)@appspot\.gserviceaccount\.com$/.exec(email)?.[1]
  );
}

const POOL_PROJECT = /projects\/(\d+)\/locations\/global\/workloadIdentityPools\//;

/**
 * 絞り込みの条件に当てはまる検出結果。
 * - reach: 原因の付与先が選んだ project（祖先の container を含む）か配下のリソースのもの、原因の経路上の SA が選んだ project にあるもの。
 *   Provider などが原因のものは、影響を受ける principal のいずれかが届くもの
 *   （principal で判定すると、org 全体に届く principal が関わる検出結果がすべての project に当てはまってしまうため、原因の場所で判定する）
 * - pool: 影響を受ける principal のいずれかが選んだ project の Pool のもの、原因の Pool / Provider が選んだ project にあるもの
 */
export function filterFindingsByProjects(snapshot: SnapshotPart, findings: Finding[], filter: ProjectFilter, principals: Set<Member>): Finding[] {
  const scope = scopeOf(snapshot, filter.projects);
  const affects = (f: Finding) => f.impact.principals.some((p) => principals.has(p));
  if (filter.mode === 'pool') {
    return findings.filter((f) => {
      const number = POOL_PROJECT.exec(f.cause.ref)?.[1];
      return affects(f) || (number !== undefined && scope.numbers.has(number));
    });
  }
  return findings.filter((f) => {
    const { cause } = f;
    if (cause.kind === 'binding' && cause.grantedOn) {
      const grantedOnKind = cause.grantedOn.startsWith(`${CRM}/`) ? 'container' : 'resource';
      return reachesScope({ grantedOn: cause.grantedOn, grantedOnKind }, scope, snapshot);
    }
    if (cause.kind === 'path') return cause.ref.split('>').some((member) => scope.ids.has(serviceAccountProjectOf(member) ?? ''));
    return affects(f);
  });
}
