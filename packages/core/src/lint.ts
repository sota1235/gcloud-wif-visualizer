import { reachableIdentities } from './effective.ts';
import { edgeId, isContainerResource } from './names.ts';
import type { ResourceCounter } from './resource-count.ts';
import type {
  AccessGraph,
  EffectiveAccess,
  HasRoleEdge,
  Member,
  PrincipalNode,
  ProviderNode,
  ServiceAccountEdge,
  WorkloadNode,
} from './types.ts';
import { detectIdp, type InferOptions } from './workload.ts';

export type Severity = 'high' | 'medium' | 'low';

export type LintRuleId =
  | 'wildcard-principal-set'
  | 'github-missing-attribute-condition'
  | 'github-name-based-trust'
  | 'github-actor-based-trust'
  | 'primitive-role'
  | 'iam-admin-reachable'
  | 'act-as-reachable'
  | 'deep-impersonation-chain'
  | 'org-level-token-creator'
  | 'disabled-but-bound'
  | 'dangling-principal'
  | 'unreachable-principal';

export interface Finding {
  /** ルールと原因から決まる決定的な ID（トリアージ状態の保存や差分に使う） */
  id: string;
  ruleId: LintRuleId;
  severity: Severity;
  /** 何が問題か（1 文） */
  message: string;
  /** 推奨される対応 */
  recommendation: string;
  /** 原因となっている設定 */
  cause: { kind: 'binding' | 'provider' | 'pool' | 'principal' | 'path'; ref: string; role?: string; grantedOn?: string };
  /** 関連するノード（UI で該当箇所へ移動するため） */
  nodeIds: string[];
  impact: { principals: Member[]; workloads: string[]; resourceCount: number };
}

export interface LintInput {
  graph: AccessGraph;
  effectiveAccess: EffectiveAccess[];
  roles: Record<string, string[]>;
  /** 影響範囲のリソース数を求める */
  countResources: ResourceCounter;
  inferOptions?: InferOptions;
}

export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const PRIMITIVE_ROLES = new Set(['roles/owner', 'roles/editor']);

/** IAM 設定や WIF 設定を書き換えられ、権限を際限なく拡大できる permission */
export const ESCALATION_PERMISSIONS: ReadonlySet<string> = new Set([
  'resourcemanager.organizations.setIamPolicy',
  'resourcemanager.folders.setIamPolicy',
  'resourcemanager.projects.setIamPolicy',
  'iam.serviceAccounts.setIamPolicy',
  'iam.roles.create',
  'iam.roles.update',
  'iam.workloadIdentityPools.update',
  'iam.workloadIdentityPoolProviders.create',
  'iam.workloadIdentityPoolProviders.update',
]);

const NAME_CLAIMS = new Set(['repository', 'repository_owner']);
const ID_CLAIMS = new Set(['repository_id', 'repository_owner_id']);

function isPowerfulRole(role: string, roles: Record<string, string[]>): boolean {
  return PRIMITIVE_ROLES.has(role) || (roles[role] ?? []).some((p) => ESCALATION_PERMISSIONS.has(p));
}

export function lint(input: LintInput): Finding[] {
  const { graph, effectiveAccess, roles, countResources } = input;
  const nodes = [...graph.nodes.values()];
  const edges = [...graph.edges.values()];
  const findings = new Map<string, Finding>();

  // principal → workload
  const workloadsByPrincipal = new Map<Member, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'RESOLVES_TO') continue;
    workloadsByPrincipal.set(edge.to, [...(workloadsByPrincipal.get(edge.to) ?? []), edge.from]);
  }

  const impactOf = (rows: EffectiveAccess[], principals: Member[] = rows.map((r) => r.principal)) => {
    const uniquePrincipals = [...new Set(principals)].sort();
    return {
      principals: uniquePrincipals,
      workloads: [...new Set(uniquePrincipals.flatMap((p) => workloadsByPrincipal.get(p) ?? []))].sort(),
      resourceCount: countResources(rows),
    };
  };

  const add = (finding: Omit<Finding, 'id'>) => {
    const id = edgeId(finding.ruleId, finding.cause.ref, finding.cause.grantedOn ?? '', finding.cause.role);
    findings.set(id, { id, ...finding });
  };

  // 実効アクセスの行を「ロールを持つ identity × ロール × 付与箇所」で引けるようにする
  const rowsByGrant = new Map<string, EffectiveAccess[]>();
  const grantKey = (identity: Member, role: string, grantedOn: string) => `${identity}|${role}|${grantedOn}`;
  for (const row of effectiveAccess) {
    const key = grantKey(row.path.at(-1)!, row.role, row.grantedOn);
    rowsByGrant.set(key, [...(rowsByGrant.get(key) ?? []), row]);
  }
  // WIF から impersonation で到達できる identity と、そこへ到達する principal
  // （ロールを持たない SA も含めるため、実効アクセスの行ではなくグラフを辿る）
  const principalsReaching = new Map<Member, Set<Member>>();
  for (const principal of nodes.filter((n) => n.kind === 'principal')) {
    for (const identity of reachableIdentities(graph, principal.id).keys()) {
      const set = principalsReaching.get(identity) ?? new Set();
      set.add(principal.id);
      principalsReaching.set(identity, set);
    }
  }
  const reachingPrincipals = (identity: Member) => [...(principalsReaching.get(identity) ?? [])];
  const roleEdges = edges.filter((e): e is HasRoleEdge => e.kind === 'HAS_ROLE');
  const powerfulIdentities = new Set(roleEdges.filter((e) => isPowerfulRole(e.role, roles)).map((e) => e.from));

  // ---- ロール付与に関するルール ----
  for (const edge of roleEdges) {
    const rows = rowsByGrant.get(grantKey(edge.from, edge.role, edge.resource)) ?? [];
    if (rows.length === 0) continue;
    const cause = { kind: 'binding' as const, ref: edge.from, role: edge.role, grantedOn: edge.resource };
    const nodeIds = [edge.from, edge.to];

    if (PRIMITIVE_ROLES.has(edge.role)) {
      add({
        ruleId: 'primitive-role',
        severity: 'high',
        message: `WIF 経由で基本ロール ${edge.role} に到達できます。`,
        recommendation: '必要な操作に対応する predefined ロールに絞ってください。',
        cause,
        nodeIds,
        impact: impactOf(rows),
      });
    } else if ((roles[edge.role] ?? []).some((p) => ESCALATION_PERMISSIONS.has(p))) {
      add({
        ruleId: 'iam-admin-reachable',
        severity: 'high',
        message: `WIF 経由で IAM / WIF の設定を書き換えられるロール ${edge.role} に到達できます。権限を際限なく拡大できます。`,
        recommendation: '付与範囲を限定し、GitHub の environment に保護ルール（required reviewers など）を設定してください。',
        cause,
        nodeIds,
        impact: impactOf(rows),
      });
    }
  }

  // ---- SA への関係に関するルール ----
  const serviceAccountEdges = edges.filter((e): e is ServiceAccountEdge => e.kind === 'CAN_IMPERSONATE' || e.kind === 'CAN_ACT_AS');
  const byBinding = new Map<string, ServiceAccountEdge[]>();
  for (const edge of serviceAccountEdges) {
    if (!principalsReaching.has(edge.from)) continue;
    const key = `${edge.kind}|${edge.from}|${edge.role}|${edge.grantedOn}`;
    byBinding.set(key, [...(byBinding.get(key) ?? []), edge]);
  }
  for (const group of byBinding.values()) {
    const [first] = group as [ServiceAccountEdge];
    const targets = group.map((e) => e.to);
    const cause = { kind: 'binding' as const, ref: first.from, role: first.role, grantedOn: first.grantedOn };
    const impact = impactOf([], reachingPrincipals(first.from));

    if (first.kind === 'CAN_ACT_AS') {
      const powerful = targets.filter((t) => powerfulIdentities.has(t));
      add({
        ruleId: 'act-as-reachable',
        severity: powerful.length > 0 ? 'high' : 'medium',
        message:
          `WIF 経由で ${targets.length} 個の SA に対する actAs 権限（${first.role}）に到達できます。` +
          (powerful.length > 0 ? `うち ${powerful.length} 個は強い権限を持つ SA です。` : ''),
        recommendation: 'actAs の付与範囲を、実際にアタッチする SA に限定してください。',
        cause,
        nodeIds: [first.from, ...targets],
        impact,
      });
    } else if (isContainerResource(first.grantedOn) && /\/(folders|organizations)\/[^/]+$/.test(first.grantedOn)) {
      add({
        ruleId: 'org-level-token-creator',
        severity: 'high',
        message: `folder / org レベルで impersonation 権限（${first.role}）が付与されており、配下の ${targets.length} 個の SA に成り代われます。`,
        recommendation: 'SA 単位の付与に置き換えてください。',
        cause,
        nodeIds: [first.from, ...targets],
        impact,
      });
    }
  }

  // ---- 経路に関するルール ----
  const rowsByPath = new Map<string, EffectiveAccess[]>();
  for (const row of effectiveAccess) {
    if (row.path.length < 3) continue;
    const key = row.path.join('>');
    rowsByPath.set(key, [...(rowsByPath.get(key) ?? []), row]);
  }
  for (const [key, rows] of rowsByPath) {
    const path = rows[0]!.path;
    add({
      ruleId: 'deep-impersonation-chain',
      severity: 'medium',
      message: `impersonation の連鎖が ${path.length - 1} 段あります。権限の経路が追いにくくなります。`,
      recommendation: '最終的に必要な SA に直接 workloadIdentityUser を付与してください。',
      cause: { kind: 'path', ref: key },
      nodeIds: path,
      impact: impactOf(rows),
    });
  }

  // ---- principal / pool / provider の設定に関するルール ----
  const principals = nodes.filter((n): n is PrincipalNode => n.kind === 'principal');
  const providers = nodes.filter((n): n is ProviderNode => n.kind === 'provider');
  const workloads = nodes.filter((n): n is WorkloadNode => n.kind === 'workload');
  const rowsByPrincipal = (p: Member) => effectiveAccess.filter((r) => r.principal === p);

  for (const principal of principals) {
    const rows = rowsByPrincipal(principal.id);
    if (principal.principalKind === 'all' && rows.length > 0) {
      add({
        ruleId: 'wildcard-principal-set',
        severity: 'high',
        message: 'Pool 内のすべての ID（principalSet の *）に権限が付与されています。',
        recommendation: 'attribute で絞った principalSet に置き換えてください。',
        cause: { kind: 'principal', ref: principal.id },
        nodeIds: [principal.id],
        impact: impactOf(rows),
      });
    }
    const pool = graph.nodes.get(principal.poolName);
    if (!pool) {
      add({
        ruleId: 'dangling-principal',
        severity: 'medium',
        message: `Org 内に存在しない Pool（${principal.poolId}）を参照するバインディングがあります。`,
        recommendation: '不要なバインディングであれば削除してください。',
        cause: { kind: 'principal', ref: principal.id },
        nodeIds: [principal.id],
        impact: impactOf(rows),
      });
    } else if (pool.kind === 'pool' && pool.pool.disabled) {
      add({
        ruleId: 'disabled-but-bound',
        severity: 'low',
        message: `無効化された Pool（${principal.poolId}）の principal へのバインディングが残っています。`,
        recommendation: '不要なバインディングを削除してください。',
        cause: { kind: 'principal', ref: principal.id },
        nodeIds: [principal.id, pool.id],
        impact: impactOf(rows),
      });
    }
  }

  for (const node of nodes) {
    if (node.kind !== 'serviceAccount' || !node.missing || !principalsReaching.has(node.id)) continue;
    add({
      ruleId: 'disabled-but-bound',
      severity: 'low',
      message: `存在しない SA（${node.email}）へのバインディングが残っています。同じ名前で SA を作り直すと権限が復活します。`,
      recommendation: '不要なバインディングを削除してください。',
      cause: { kind: 'principal', ref: node.id },
      nodeIds: [node.id],
      impact: impactOf([], reachingPrincipals(node.id)),
    });
  }

  for (const workload of workloads) {
    if (!workload.workload.unreachable) continue;
    add({
      ruleId: 'unreachable-principal',
      severity: 'low',
      message: `principal の値が Provider の attributeCondition と矛盾しており、このバインディングは使われません（${workload.workload.label}）。`,
      recommendation: '不要なバインディングであれば削除してください。設定ミスの可能性もあります。',
      cause: { kind: 'principal', ref: workload.workload.principal, grantedOn: workload.workload.provider },
      nodeIds: [workload.id, workload.workload.principal],
      impact: impactOf(rowsByPrincipal(workload.workload.principal)),
    });
  }

  for (const provider of providers) {
    if (detectIdp(provider.provider, input.inferOptions) !== 'github') continue;
    const providerWorkloads = workloads.filter((w) => w.workload.provider === provider.id);
    const bound = [...new Set(providerWorkloads.map((w) => w.workload.principal))];
    const impact = impactOf(bound.flatMap(rowsByPrincipal), bound);
    const cause = { kind: 'provider' as const, ref: provider.id };

    if (!provider.provider.attributeCondition) {
      add({
        ruleId: 'github-missing-attribute-condition',
        severity: 'high',
        message: 'GitHub の Provider に attributeCondition がありません。他の組織・ユーザーのリポジトリからもトークンを受け入れます。',
        recommendation: "attributeCondition に assertion.repository_owner_id == '<ID>' などの条件を設定してください。",
        cause,
        nodeIds: [provider.id],
        impact,
      });
    }

    const constrainedClaims = new Set(providerWorkloads.flatMap((w) => w.workload.constraints.filter((c) => c.op !== 'ne').map((c) => c.claim)));
    const usesName = [...constrainedClaims].some((c) => NAME_CLAIMS.has(c));
    const usesId = [...constrainedClaims].some((c) => ID_CLAIMS.has(c));
    if (usesName && !usesId) {
      add({
        ruleId: 'github-name-based-trust',
        severity: 'medium',
        message: 'リポジトリ / オーナーを名前だけで信頼しています。名前が解放・再取得されると、第三者のリポジトリからアクセスされるおそれがあります。',
        recommendation: 'repository_id / repository_owner_id を使った mapping と attributeCondition に移行してください。',
        cause,
        nodeIds: [provider.id],
        impact,
      });
    }

    const conditionClaims = new Set(providerWorkloads.flatMap((w) => w.workload.constraints.filter((c) => c.source === 'condition').map((c) => c.claim)));
    if (conditionClaims.has('actor') || conditionClaims.has('triggering_actor')) {
      add({
        ruleId: 'github-actor-based-trust',
        severity: 'low',
        message: 'attributeCondition が実行者（actor）に依存しています。actor は名前ベースで、workflow の再実行者によっても変わります。',
        recommendation: 'owner / repo の ID と environment で制限してください。',
        cause,
        nodeIds: [provider.id],
        impact,
      });
    }
  }

  return [...findings.values()].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.impact.resourceCount - a.impact.resourceCount || a.id.localeCompare(b.id),
  );
}
