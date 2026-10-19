/** SA の資格情報を得られる（= SA として振る舞える）permission */
export const IMPERSONATION_PERMISSIONS: ReadonlySet<string> = new Set([
  'iam.serviceAccounts.getAccessToken',
  'iam.serviceAccounts.getOpenIdToken',
  'iam.serviceAccounts.signJwt',
  'iam.serviceAccounts.signBlob',
  'iam.serviceAccounts.implicitDelegation',
  // 鍵を作れれば長期的な資格情報を得られる
  'iam.serviceAccountKeys.create',
]);

/** SA をリソースにアタッチできる permission（間接的な昇格の可能性） */
export const ACT_AS_PERMISSION = 'iam.serviceAccounts.actAs';

export interface ServiceAccountCapabilities {
  impersonate: boolean;
  actAs: boolean;
}

export function serviceAccountCapabilities(permissions: readonly string[]): ServiceAccountCapabilities {
  return {
    impersonate: permissions.some((p) => IMPERSONATION_PERMISSIONS.has(p)),
    actAs: permissions.includes(ACT_AS_PERMISSION),
  };
}
