import { parseCel, summarizeCondition, type Constraint, type ConstraintOp } from './cel.ts';
import type { PrincipalNode, WorkloadIdentityPoolProvider } from './types.ts';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';

export type IdpKind = 'github' | 'unknown';

export interface InferOptions {
  /** GitHub Enterprise Server などの追加の GitHub issuer */
  githubIssuers?: string[];
}

/** claim（または解決できなかった参照）に対する制約 */
export interface ClaimConstraint {
  /** claim 名（assertion.X の X）。解決できなかった場合は参照パスのまま */
  claim: string;
  op: ConstraintOp;
  values: string[];
  /** 制約の出所 */
  source: 'principal' | 'condition';
}

export interface GitHubWorkload {
  owner?: string;
  repository?: string;
  ownerId?: string;
  repositoryId?: string;
  refs?: string[];
  environments?: string[];
  workflows?: string[];
  actors?: string[];
  pullRequest?: boolean;
}

export interface Workload {
  id: string;
  principal: string;
  provider: string;
  idp: IdpKind;
  /** 表示用のラベル */
  label: string;
  constraints: ClaimConstraint[];
  /** attributeCondition のうち解釈できなかった部分 */
  unparsedConditions: string[];
  /** 解釈できなかった attributeMapping（attribute 名 → 式） */
  unresolvedMappings: Record<string, string>;
  /** principal の値と attributeCondition が矛盾し、このワークロードは存在し得ない */
  unreachable: boolean;
  /** 推定がすべて解釈できた範囲に基づくか */
  confidence: 'exact' | 'partial';
  github?: GitHubWorkload;
}

export function detectIdp(provider: WorkloadIdentityPoolProvider, options: InferOptions = {}): IdpKind {
  const issuers = [GITHUB_ISSUER, ...(options.githubIssuers ?? [])];
  return provider.issuerUri && issuers.includes(provider.issuerUri.replace(/\/$/, '')) ? 'github' : 'unknown';
}

/** attributeMapping を「google.subject / attribute.X → claim 名」に逆変換する。単純な assertion.X のみ対応 */
export function reverseMapping(mapping: Record<string, string>): { claims: Map<string, string>; unresolved: Record<string, string> } {
  const claims = new Map<string, string>();
  const unresolved: Record<string, string> = {};
  for (const [target, expression] of Object.entries(mapping)) {
    try {
      const node = parseCel(expression);
      if (node.type === 'ref' && node.path.startsWith('assertion.')) {
        claims.set(target, node.path.slice('assertion.'.length));
        continue;
      }
    } catch {
      // 解釈できない式は unresolved に入れる
    }
    unresolved[target] = expression;
  }
  return { claims, unresolved };
}

/** GitHub の sub claim（例: repo:org/repo:ref:refs/heads/main）を claim の組に分解する */
export function parseGitHubSubject(subject: string): Record<string, string> {
  const tokens = subject.split(':');
  const claims: Record<string, string> = {};
  for (let i = 0; i < tokens.length; ) {
    const key = tokens[i]!;
    if (key === 'pull_request') {
      claims.event_name = 'pull_request';
      i += 1;
      continue;
    }
    const value = tokens[i + 1];
    if (value === undefined) break;
    claims[key === 'repo' ? 'repository' : key] = value;
    i += 2;
  }
  return claims;
}

function resolveRef(ref: string, claims: Map<string, string>): string {
  if (ref.startsWith('assertion.')) return ref.slice('assertion.'.length);
  return claims.get(ref) ?? ref;
}

/** 制約に矛盾があるか（同じ claim に異なる値の eq、in の候補が空になる場合） */
function isContradictory(constraints: ClaimConstraint[]): boolean {
  const allowed = new Map<string, Set<string>>();
  for (const c of constraints) {
    if (c.op !== 'eq' && c.op !== 'in') continue;
    const values = new Set(c.values);
    const current = allowed.get(c.claim);
    allowed.set(c.claim, current ? new Set([...current].filter((v) => values.has(v))) : values);
  }
  for (const c of constraints) {
    if (c.op !== 'ne') continue;
    const values = allowed.get(c.claim);
    if (values && [...values].every((v) => c.values.includes(v))) return true;
  }
  return [...allowed.values()].some((values) => values.size === 0);
}

/** claim の値として確定しているもの（eq / in の積集合） */
function allowedValues(constraints: ClaimConstraint[], claim: string): string[] | undefined {
  let result: string[] | undefined;
  for (const c of constraints) {
    if (c.claim !== claim || (c.op !== 'eq' && c.op !== 'in')) continue;
    result = result ? result.filter((v) => c.values.includes(v)) : [...c.values];
  }
  return result;
}

function githubWorkload(constraints: ClaimConstraint[]): GitHubWorkload {
  const one = (claim: string) => {
    const values = allowedValues(constraints, claim);
    return values?.length === 1 ? values[0] : undefined;
  };
  const many = (...claims: string[]) => {
    const values = claims.flatMap((claim) => allowedValues(constraints, claim) ?? []);
    return values.length > 0 ? [...new Set(values)] : undefined;
  };

  const repository = one('repository');
  const owner = one('repository_owner') ?? repository?.split('/')[0];
  const workload: GitHubWorkload = {
    ...(owner ? { owner } : {}),
    ...(repository ? { repository } : {}),
    ...(one('repository_owner_id') ? { ownerId: one('repository_owner_id') } : {}),
    ...(one('repository_id') ? { repositoryId: one('repository_id') } : {}),
  };
  const refs = many('ref');
  const environments = many('environment');
  const workflows = many('job_workflow_ref', 'workflow_ref', 'workflow');
  const actors = many('actor');
  if (refs) workload.refs = refs;
  if (environments) workload.environments = environments;
  if (workflows) workload.workflows = workflows;
  if (actors) workload.actors = actors;
  if (allowedValues(constraints, 'event_name')?.includes('pull_request')) workload.pullRequest = true;
  return workload;
}

function githubLabel(github: GitHubWorkload): string {
  const target = github.repository ?? (github.owner ? `${github.owner}/*` : github.repositoryId ? `repository_id:${github.repositoryId}` : github.ownerId ? `owner_id:${github.ownerId}/*` : '全リポジトリ');
  const qualifiers = [
    github.environments && `environment: ${github.environments.join(', ')}`,
    github.refs && `ref: ${github.refs.join(', ')}`,
    github.workflows && `workflow: ${github.workflows.join(', ')}`,
    github.pullRequest && 'pull_request',
  ].filter(Boolean);
  return `GitHub ${target}${qualifiers.length > 0 ? ` (${qualifiers.join(' / ')})` : ''}`;
}

function genericLabel(constraints: ClaimConstraint[]): string {
  const parts = constraints.filter((c) => c.op === 'eq' || c.op === 'in').map((c) => `${c.claim}=${c.values.join('|')}`);
  return parts.length > 0 ? parts.join(', ') : '全ワークロード';
}

/** principal と provider の設定から、外部ワークロードを推定する */
export function inferWorkload(principal: PrincipalNode, provider: WorkloadIdentityPoolProvider, options: InferOptions = {}): Workload {
  const idp = detectIdp(provider, options);
  const { claims, unresolved } = reverseMapping(provider.attributeMapping);
  const constraints: ClaimConstraint[] = [];

  // principal の値から得られる制約
  if (principal.principalKind === 'attribute' && principal.attributeKey && principal.value !== undefined) {
    const claim = resolveRef(`attribute.${principal.attributeKey}`, claims);
    constraints.push({ claim, op: 'eq', values: [principal.value], source: 'principal' });
  } else if (principal.principalKind === 'subject' && principal.value !== undefined) {
    const subjectClaim = claims.get('google.subject');
    if (idp === 'github' && subjectClaim === 'sub') {
      for (const [claim, value] of Object.entries(parseGitHubSubject(principal.value))) {
        constraints.push({ claim, op: 'eq', values: [value], source: 'principal' });
      }
    } else {
      constraints.push({ claim: subjectClaim ?? 'google.subject', op: 'eq', values: [principal.value], source: 'principal' });
    }
  } else if (principal.principalKind === 'group' && principal.value !== undefined) {
    constraints.push({ claim: claims.get('google.groups') ?? 'google.groups', op: 'in', values: [principal.value], source: 'principal' });
  }

  // attributeCondition から得られる制約
  const summary = provider.attributeCondition ? summarizeCondition(provider.attributeCondition) : { constraints: [] as Constraint[], unparsed: [] };
  for (const c of summary.constraints) {
    constraints.push({ claim: resolveRef(c.ref, claims), op: c.op, values: c.values, source: 'condition' });
  }

  // 推定に使った参照のうち、claim に戻せなかった mapping だけを unresolved とする
  const usedTargets = new Set([
    ...(principal.attributeKey ? [`attribute.${principal.attributeKey}`] : []),
    ...(principal.principalKind === 'subject' ? ['google.subject'] : []),
    ...(principal.principalKind === 'group' ? ['google.groups'] : []),
    ...summary.constraints.map((c) => c.ref),
  ]);
  const unresolvedMappings = Object.fromEntries(Object.entries(unresolved).filter(([target]) => usedTargets.has(target)));

  const github = idp === 'github' ? githubWorkload(constraints) : undefined;
  return {
    id: `workload|${provider.name}|${principal.id}`,
    principal: principal.id,
    provider: provider.name,
    idp,
    label: github ? githubLabel(github) : genericLabel(constraints),
    constraints,
    unparsedConditions: summary.unparsed,
    unresolvedMappings,
    unreachable: isContradictory(constraints),
    confidence: summary.unparsed.length === 0 && Object.keys(unresolvedMappings).length === 0 ? 'exact' : 'partial',
    ...(github ? { github } : {}),
  };
}

/** principal が属する pool の provider ごとにワークロードを推定する */
export function inferWorkloads(principal: PrincipalNode, providers: WorkloadIdentityPoolProvider[], options: InferOptions = {}): Workload[] {
  return providers
    .filter((p) => p.poolName === principal.poolName)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((provider) => inferWorkload(principal, provider, options));
}
