/**
 * permission の "service.collection" → そのロールで操作できるアセットタイプ。
 * Cloud Asset の searchAllResources で検索できるタイプだけを載せる
 * （例: cloudscheduler.googleapis.com/Job は検索できないため載せない）。
 */
export const PERMISSION_ASSET_TYPES: Readonly<Record<string, readonly string[]>> = {
  'storage.buckets': ['storage.googleapis.com/Bucket'],
  'storage.objects': ['storage.googleapis.com/Bucket'],
  'bigquery.datasets': ['bigquery.googleapis.com/Dataset'],
  'bigquery.tables': ['bigquery.googleapis.com/Table'],
  'secretmanager.secrets': ['secretmanager.googleapis.com/Secret'],
  'secretmanager.versions': ['secretmanager.googleapis.com/Secret'],
  'artifactregistry.repositories': ['artifactregistry.googleapis.com/Repository'],
  'artifactregistry.dockerimages': ['artifactregistry.googleapis.com/Repository'],
  'run.services': ['run.googleapis.com/Service'],
  'run.jobs': ['run.googleapis.com/Job'],
  'cloudfunctions.functions': ['cloudfunctions.googleapis.com/CloudFunction', 'cloudfunctions.googleapis.com/Function'],
  'pubsub.topics': ['pubsub.googleapis.com/Topic'],
  'pubsub.subscriptions': ['pubsub.googleapis.com/Subscription'],
  'compute.instances': ['compute.googleapis.com/Instance'],
  'container.clusters': ['container.googleapis.com/Cluster'],
  'cloudsql.instances': ['sqladmin.googleapis.com/Instance'],
  'cloudkms.cryptoKeys': ['cloudkms.googleapis.com/CryptoKey'],
  'cloudkms.cryptoKeyVersions': ['cloudkms.googleapis.com/CryptoKey'],
  'iam.serviceAccounts': ['iam.googleapis.com/ServiceAccount'],
  'iam.serviceAccountKeys': ['iam.googleapis.com/ServiceAccount'],
  'datastore.entities': ['firestore.googleapis.com/Database'],
  'datastore.databases': ['firestore.googleapis.com/Database'],
};

/** collector がインベントリとして取得すべきアセットタイプ */
export const EXPANDABLE_ASSET_TYPES: readonly string[] = [...new Set(Object.values(PERMISSION_ASSET_TYPES).flat())].sort();

export function permissionCollection(permission: string): string {
  return permission.split('.').slice(0, 2).join('.');
}

export interface RoleAssetTypes {
  /** 展開先のアセットタイプ */
  assetTypes: string[];
  /** 対応表にない permission（container 単位のまま扱う） */
  unmappedPermissions: string[];
}

export function assetTypesForPermissions(permissions: readonly string[]): RoleAssetTypes {
  const assetTypes = new Set<string>();
  const unmappedPermissions: string[] = [];
  for (const permission of permissions) {
    const types = PERMISSION_ASSET_TYPES[permissionCollection(permission)];
    if (types) {
      for (const t of types) assetTypes.add(t);
    } else {
      unmappedPermissions.push(permission);
    }
  }
  return { assetTypes: [...assetTypes].sort(), unmappedPermissions };
}
