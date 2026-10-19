export type NodeType = 'pool' | 'principal' | 'sa' | 'container' | 'resourceGroup';
export type EdgeKind = 'trusts' | 'impersonate' | 'actAs' | 'role' | 'contains';
export type GraphNode = { id: string; type: NodeType; label: string; detail?: string };
export type GraphEdge = { id: string; source: string; target: string; kind: EdgeKind; label?: string };
export type Graph = { name: string; nodes: GraphNode[]; edges: GraphEdge[] };
export type Positions = Map<string, { x: number; y: number }>;

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 36;

export const NODE_COLORS: Record<NodeType, string> = {
  pool: '#6366f1',
  principal: '#0ea5e9',
  sa: '#f59e0b',
  container: '#64748b',
  resourceGroup: '#10b981',
};

export const EDGE_COLORS: Record<EdgeKind, string> = {
  trusts: '#93c5fd',
  impersonate: '#f97316',
  actAs: '#ef4444',
  role: '#94a3b8',
  contains: '#a7f3d0',
};

export type RenderMetrics = { renderMs: number };
