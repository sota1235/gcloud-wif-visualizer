import type { ExploreResult } from './explore.ts';
import {
  edgeId,
  isContainerResource,
  parseWifPrincipal,
  serviceAccountEmailFromMember,
  serviceAccountEmailFromResource,
  serviceAccountMember,
} from './names.ts';
import type {
  AccessGraph,
  Container,
  GraphEdge,
  GraphNode,
  HasRoleEdge,
  Member,
  WorkloadIdentityPool,
  WorkloadIdentityPoolProvider,
} from './types.ts';

export interface BuildGraphInput {
  pools: WorkloadIdentityPool[];
  providers: WorkloadIdentityPoolProvider[];
  containers: Container[];
  explored: ExploreResult;
  /** Org 内に存在する SA の email。指定した場合、含まれない SA を missing として扱う */
  existingServiceAccounts?: ReadonlySet<string>;
}

/** HAS_ROLE の付与先ノード ID。SA は member 形式に揃え、identity としての SA ノードと同一視する */
export function roleTargetId(resource: string): string {
  const email = serviceAccountEmailFromResource(resource);
  return email ? serviceAccountMember(email) : resource;
}

export function buildAccessGraph(input: BuildGraphInput): AccessGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addNode = (node: GraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };

  for (const pool of input.pools) addNode({ kind: 'pool', id: pool.name, pool });
  for (const provider of input.providers) {
    addNode({ kind: 'provider', id: provider.name, provider });
    const id = edgeId('TRUSTS', provider.name, provider.poolName);
    edges.set(id, { kind: 'TRUSTS', id, from: provider.name, to: provider.poolName });
  }
  for (const container of input.containers) addNode({ kind: 'container', id: container.name, container });

  const addIdentity = (member: Member) => {
    const principal = parseWifPrincipal(member);
    if (principal) return addNode(principal);
    const email = serviceAccountEmailFromMember(member);
    if (email) {
      const missing = input.existingServiceAccounts ? !input.existingServiceAccounts.has(email) : false;
      addNode({ kind: 'serviceAccount', id: member, email, ...(missing ? { missing } : {}) });
    }
  };
  for (const member of input.explored.depth.keys()) addIdentity(member);

  for (const edge of input.explored.serviceAccountEdges) {
    addIdentity(edge.from);
    addIdentity(edge.to);
    edges.set(edge.id, edge);
  }

  for (const binding of input.explored.bindings) {
    addIdentity(binding.member);
    const to = roleTargetId(binding.resource);
    if (to !== binding.resource) {
      addIdentity(to);
    } else if (!isContainerResource(binding.resource)) {
      addNode({ kind: 'resource', id: binding.resource });
    }
    // Org 外の container（共有された project など）は container 情報がないので resource として扱う
    if (isContainerResource(binding.resource) && !nodes.has(binding.resource)) {
      addNode({ kind: 'resource', id: binding.resource });
    }
    const id = edgeId('HAS_ROLE', binding.member, to, binding.role, binding.condition?.expression);
    const edge: HasRoleEdge = {
      kind: 'HAS_ROLE',
      id,
      from: binding.member,
      to,
      role: binding.role,
      resource: binding.resource,
      ...(binding.condition ? { condition: binding.condition } : {}),
    };
    edges.set(id, edge);
  }

  return { nodes, edges };
}
