import { assetTypesForPermissions } from './asset-types.ts';
import { edgeId, isContainerResource } from './names.ts';
import type {
  AccessGraph,
  AccessibleResource,
  Container,
  EffectiveAccess,
  FullResourceName,
  GraphEdge,
  HasRoleEdge,
  InventoryResource,
  Member,
  ServiceAccountEdge,
} from './types.ts';

interface Reach {
  path: Member[];
  conditional: boolean;
}

function outgoingEdges(graph: AccessGraph) {
  const impersonation = new Map<string, ServiceAccountEdge[]>();
  const roles = new Map<string, HasRoleEdge[]>();
  const push = <T extends GraphEdge>(map: Map<string, T[]>, edge: T) => {
    const list = map.get(edge.from) ?? [];
    list.push(edge);
    map.set(edge.from, list);
  };
  for (const edge of graph.edges.values()) {
    if (edge.kind === 'CAN_IMPERSONATE') push(impersonation, edge);
    if (edge.kind === 'HAS_ROLE') push(roles, edge);
  }
  return { impersonation, roles };
}

/** principal から impersonation で到達できる identity と、その最短経路を求める */
export function reachableIdentities(graph: AccessGraph, principal: Member): Map<Member, Reach> {
  return reachFrom(outgoingEdges(graph).impersonation, principal);
}

function reachFrom(impersonation: Map<string, ServiceAccountEdge[]>, principal: Member): Map<Member, Reach> {
  const reached = new Map<Member, Reach>([[principal, { path: [principal], conditional: false }]]);
  let frontier = [principal];
  while (frontier.length > 0) {
    const next: Member[] = [];
    for (const identity of frontier) {
      const current = reached.get(identity)!;
      // 同じ SA への付与が複数ある場合、条件なしの付与が 1 つでもあれば無条件とみなす
      const byTarget = new Map<Member, boolean>();
      for (const edge of impersonation.get(identity) ?? []) {
        const conditional = edge.condition !== undefined;
        byTarget.set(edge.to, (byTarget.get(edge.to) ?? true) && conditional);
      }
      for (const [target, conditional] of [...byTarget].sort(([a], [b]) => a.localeCompare(b))) {
        if (reached.has(target)) continue;
        reached.set(target, { path: [...current.path, target], conditional: current.conditional || conditional });
        next.push(target);
      }
    }
    frontier = next;
  }
  return reached;
}

/** インベントリの `project` / `folders` / `organization` と照合するための container のキー */
function containerKey(container: Container): string {
  if (container.type === 'project') return `projects/${container.projectNumber ?? container.id}`;
  return `${container.type === 'folder' ? 'folders' : 'organizations'}/${container.id}`;
}

export interface ExpansionContext {
  /** 展開対象のアセットタイプのインベントリ */
  inventory: InventoryResource[];
  /** ロール → permission（カスタムロールを含む） */
  rolePermissions: Record<string, string[]>;
}

/** container に付与されたロールを、配下の実リソースに展開する */
export function createResourceExpander(graph: AccessGraph, context: ExpansionContext) {
  const containers = new Map<FullResourceName, Container>();
  for (const node of graph.nodes.values()) {
    if (node.kind === 'container') containers.set(node.id, node.container);
  }
  const inventoryByName = new Map(context.inventory.map((r) => [r.name, r]));
  const inventoryByType = new Map<string, { resource: InventoryResource; ancestors: Set<string> }[]>();
  for (const resource of context.inventory) {
    const ancestors = new Set([resource.project, resource.organization, ...resource.folders].filter((a): a is string => !!a));
    const list = inventoryByType.get(resource.assetType) ?? [];
    list.push({ resource, ancestors });
    inventoryByType.set(resource.assetType, list);
  }
  const cache = new Map<string, AccessibleResource[]>();

  const resourcesUnder = (grantedOn: FullResourceName, assetTypes: string[]): AccessibleResource[] => {
    const container = containers.get(grantedOn);
    if (!container || assetTypes.length === 0) return [];
    const cacheKey = `${grantedOn}|${assetTypes.join(',')}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const key = containerKey(container);
    const resources = assetTypes
      .flatMap((type) => inventoryByType.get(type) ?? [])
      .filter((entry) => entry.ancestors.has(key))
      .map(({ resource }) => ({ name: resource.name, assetType: resource.assetType }))
      .sort((a, b) => a.name.localeCompare(b.name));
    cache.set(cacheKey, resources);
    return resources;
  };

  return (edge: HasRoleEdge): Pick<EffectiveAccess, 'grantedOnKind' | 'resources' | 'unmappedPermissionCount'> => {
    if (!isContainerResource(edge.resource)) {
      const assetType = inventoryByName.get(edge.resource)?.assetType;
      return { grantedOnKind: 'resource', resources: [{ name: edge.resource, ...(assetType ? { assetType } : {}) }], unmappedPermissionCount: 0 };
    }
    const permissions = context.rolePermissions[edge.role];
    if (!permissions) throw new Error(`permissions of role ${edge.role} are not provided`);
    const { assetTypes, unmappedPermissions } = assetTypesForPermissions(permissions);
    return { grantedOnKind: 'container', resources: resourcesUnder(edge.resource, assetTypes), unmappedPermissionCount: unmappedPermissions.length };
  };
}

/** principal ごとに、到達できる identity のロール付与を実効アクセスとして列挙し、実リソースに展開する */
export function computeEffectiveAccess(graph: AccessGraph, context: ExpansionContext): EffectiveAccess[] {
  const { impersonation, roles } = outgoingEdges(graph);
  const expand = createResourceExpander(graph, context);
  const rows = new Map<string, EffectiveAccess>();
  const principals = [...graph.nodes.values()].filter((n) => n.kind === 'principal');

  for (const principal of principals) {
    for (const [identity, reach] of reachFrom(impersonation, principal.id)) {
      for (const edge of roles.get(identity) ?? []) {
        const id = edgeId('ACCESS', principal.id, edge.resource, edge.role, reach.path.join('>'));
        const conditional = reach.conditional || edge.condition !== undefined;
        const existing = rows.get(id);
        // 条件だけが異なる同じ付与は 1 行にまとめ、条件なしのものがあれば無条件とみなす
        if (existing) {
          existing.conditional &&= conditional;
          continue;
        }
        rows.set(id, {
          id,
          principal: principal.id,
          path: reach.path,
          role: edge.role,
          grantedOn: edge.resource,
          ...expand(edge),
          conditional,
        });
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}
