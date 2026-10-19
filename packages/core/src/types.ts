// ---- collector から渡される入力（GCP API のレスポンスを正規化したもの） ----

/** IAM の member 文字列（`serviceAccount:...`、`principalSet://...` など） */
export type Member = string;

/** Cloud Asset の full resource name（`//cloudresourcemanager.googleapis.com/projects/foo` など） */
export type FullResourceName = string;

export type ContainerType = 'organization' | 'folder' | 'project';

export interface Container {
  name: FullResourceName;
  type: ContainerType;
  /** organization / folder は数値 ID、project は project ID */
  id: string;
  /** project の場合のみ。principal の識別子には project number が使われる */
  projectNumber?: string;
  displayName?: string;
  /** 親 container の full resource name（organization は undefined） */
  parent?: FullResourceName;
}

export interface WorkloadIdentityPool {
  /** `projects/{number}/locations/global/workloadIdentityPools/{poolId}` */
  name: string;
  projectNumber: string;
  poolId: string;
  displayName?: string;
  disabled: boolean;
}

export type ProviderKind = 'oidc' | 'aws' | 'saml' | 'x509' | 'unknown';

export interface WorkloadIdentityPoolProvider {
  /** `projects/{number}/locations/global/workloadIdentityPools/{poolId}/providers/{providerId}` */
  name: string;
  poolName: string;
  providerId: string;
  kind: ProviderKind;
  issuerUri?: string;
  allowedAudiences?: string[];
  attributeMapping: Record<string, string>;
  attributeCondition?: string;
  disabled: boolean;
}

export interface IamCondition {
  expression: string;
  title?: string;
}

/** 1 つの member に対する 1 つのロール付与 */
export interface MemberBinding {
  /** ロールが付与されているリソース */
  resource: FullResourceName;
  role: string;
  member: Member;
  condition?: IamCondition;
}

// ---- グラフ ----

export type NodeKind = 'pool' | 'provider' | 'principal' | 'serviceAccount' | 'container' | 'resource';

export type PrincipalKind = 'subject' | 'group' | 'attribute' | 'all';

export interface PoolNode {
  kind: 'pool';
  id: string;
  pool: WorkloadIdentityPool;
}

export interface ProviderNode {
  kind: 'provider';
  id: string;
  provider: WorkloadIdentityPoolProvider;
}

export interface PrincipalNode {
  kind: 'principal';
  /** member 文字列そのもの */
  id: Member;
  principalKind: PrincipalKind;
  projectNumber: string;
  poolId: string;
  /** pool の name（`projects/{number}/locations/global/workloadIdentityPools/{poolId}`） */
  poolName: string;
  /** subject / group の値、attribute の値 */
  value?: string;
  /** principalKind が attribute の場合の属性名（`attribute.` を除いたもの） */
  attributeKey?: string;
}

export interface ServiceAccountNode {
  kind: 'serviceAccount';
  /** `serviceAccount:{email}` */
  id: Member;
  email: string;
  /** 存在が確認できなかった SA（削除済みなど） */
  missing?: boolean;
}

export interface ContainerNode {
  kind: 'container';
  id: FullResourceName;
  container: Container;
}

export interface ResourceNode {
  kind: 'resource';
  id: FullResourceName;
  assetType?: string;
}

export type GraphNode = PoolNode | ProviderNode | PrincipalNode | ServiceAccountNode | ContainerNode | ResourceNode;

export type EdgeKind = 'TRUSTS' | 'CAN_IMPERSONATE' | 'CAN_ACT_AS' | 'HAS_ROLE';

interface EdgeBase {
  id: string;
  from: string;
  to: string;
}

/** provider → pool */
export interface TrustsEdge extends EdgeBase {
  kind: 'TRUSTS';
}

/** identity が持つロール付与（付与先は container、SA を含むリソース） */
export interface HasRoleEdge extends EdgeBase {
  kind: 'HAS_ROLE';
  role: string;
  /** 付与先の full resource name（SA の場合、to は member 形式になるため別に保持する） */
  resource: FullResourceName;
  condition?: IamCondition;
}

/** identity → SA。impersonation / actAs ができる関係（付与箇所とロールを保持する） */
export interface ServiceAccountEdge extends EdgeBase {
  kind: 'CAN_IMPERSONATE' | 'CAN_ACT_AS';
  role: string;
  /** ロールが付与されている箇所（SA 自身、または project / folder / org） */
  grantedOn: FullResourceName;
  condition?: IamCondition;
}

export type GraphEdge = TrustsEdge | HasRoleEdge | ServiceAccountEdge;

export interface AccessGraph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
}

// ---- 派生データ ----

/** 誰が・何に・何のロールで・どの経路で到達できるか */
export interface EffectiveAccess {
  id: string;
  /** 起点の WIF principal */
  principal: Member;
  /** principal から、ロールを持つ identity までの経路（principal を含む） */
  path: Member[];
  role: string;
  /** バインディングがある箇所 */
  grantedOn: FullResourceName;
  /** 展開後の実リソース（展開していない場合は grantedOn と同じ） */
  resource: FullResourceName;
  assetType?: string;
  expanded: boolean;
  /** 経路上に IAM Condition があるか */
  conditional: boolean;
}

export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface Snapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  collectedAt: string;
  org: { id: string; displayName?: string };
  options: { maxDepth: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  effectiveAccess: EffectiveAccess[];
}
