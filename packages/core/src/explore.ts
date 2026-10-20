import { edgeId, isContainerResource, serviceAccountEmailFromResource, serviceAccountMember } from './names.ts';
import { serviceAccountCapabilities } from './permissions.ts';
import type { AccessSource } from './source.ts';
import type { Member, MemberBinding, ServiceAccountEdge } from './types.ts';

export interface ExploreOptions {
  /** principal から辿る SA の段数の上限 */
  maxDepth: number;
}

export interface ExploreResult {
  /** 探索した identity（principal と SA）に付与されたバインディング */
  bindings: MemberBinding[];
  /** identity → SA の impersonation / actAs 関係 */
  serviceAccountEdges: ServiceAccountEdge[];
  /** identity ごとの、principal からの最短段数（principal は 0） */
  depth: Map<Member, number>;
  /** maxDepth に達したため、バインディングを取得しなかった SA */
  truncated: Set<Member>;
  /** actAs でのみ到達する SA。権限の強さを判定するためバインディングは取得するが、その先は辿らない */
  actAsOnly: Set<Member>;
}

/**
 * WIF principal を起点に、impersonation 可能な SA を幅優先で辿り、到達した identity のバインディングを集める。
 * actAs は関係として記録するが、辿らない。
 */
export async function explore(principals: Member[], source: AccessSource, options: ExploreOptions): Promise<ExploreResult> {
  const permissionsCache = new Map<string, Promise<string[]>>();
  const rolePermissions = (role: string) => {
    let cached = permissionsCache.get(role);
    if (!cached) {
      cached = source.rolePermissions(role);
      permissionsCache.set(role, cached);
    }
    return cached;
  };
  const serviceAccountsCache = new Map<string, Promise<string[]>>();
  const serviceAccountsUnder = (container: string) => {
    let cached = serviceAccountsCache.get(container);
    if (!cached) {
      cached = source.serviceAccountsUnder(container);
      serviceAccountsCache.set(container, cached);
    }
    return cached;
  };

  // バインディングの付与先から、権限が及ぶ SA を求める
  const targetServiceAccounts = async (binding: MemberBinding): Promise<Member[]> => {
    const email = serviceAccountEmailFromResource(binding.resource);
    if (email) return [serviceAccountMember(email)];
    if (isContainerResource(binding.resource)) {
      return (await serviceAccountsUnder(binding.resource)).map(serviceAccountMember);
    }
    return [];
  };

  const bindings: MemberBinding[] = [];
  const serviceAccountEdges = new Map<string, ServiceAccountEdge>();
  const depth = new Map<Member, number>();
  const truncated = new Set<Member>();

  let frontier = [...new Set(principals)];
  for (const p of frontier) depth.set(p, 0);

  while (frontier.length > 0) {
    const level = await Promise.all(
      frontier.map(async (identity) => ({ identity, bindings: await source.bindingsForMember(identity) })),
    );
    const next: Member[] = [];

    for (const { identity, bindings: identityBindings } of level) {
      const identityDepth = depth.get(identity) ?? 0;
      for (const binding of identityBindings) {
        bindings.push(binding);
        const capabilities = serviceAccountCapabilities(await rolePermissions(binding.role));
        if (!capabilities.impersonate && !capabilities.actAs) continue;

        for (const target of await targetServiceAccounts(binding)) {
          if (target === identity) continue;
          const kinds = [
            ...(capabilities.impersonate ? (['CAN_IMPERSONATE'] as const) : []),
            ...(capabilities.actAs ? (['CAN_ACT_AS'] as const) : []),
          ];
          for (const kind of kinds) {
            const id = edgeId(kind, identity, target, binding.role, binding.resource, binding.condition?.expression);
            serviceAccountEdges.set(id, {
              kind,
              id,
              from: identity,
              to: target,
              role: binding.role,
              grantedOn: binding.resource,
              ...(binding.condition ? { condition: binding.condition } : {}),
            });
          }

          if (!capabilities.impersonate || depth.has(target)) continue;
          const targetDepth = identityDepth + 1;
          depth.set(target, targetDepth);
          if (targetDepth > options.maxDepth) {
            truncated.add(target);
          } else {
            next.push(target);
          }
        }
      }
    }
    frontier = next;
  }

  const actAsOnly = new Set(
    [...serviceAccountEdges.values()].filter((e) => e.kind === 'CAN_ACT_AS' && !depth.has(e.to)).map((e) => e.to),
  );
  const actAsBindings = await Promise.all([...actAsOnly].map((sa) => source.bindingsForMember(sa)));
  bindings.push(...actAsBindings.flat());

  return {
    bindings,
    serviceAccountEdges: [...serviceAccountEdges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    depth,
    truncated,
    actAsOnly,
  };
}
