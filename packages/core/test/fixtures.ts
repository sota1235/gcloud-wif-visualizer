import type { StaticSourceData } from '../src/source.ts';
import type { Container, MemberBinding } from '../src/types.ts';

export const ORG = '//cloudresourcemanager.googleapis.com/organizations/1';
export const FOLDER = '//cloudresourcemanager.googleapis.com/folders/10';
export const PROJECT_A = '//cloudresourcemanager.googleapis.com/projects/proj-a';
export const PROJECT_B = '//cloudresourcemanager.googleapis.com/projects/proj-b';

export const containers: Container[] = [
  { name: ORG, type: 'organization', id: '1' },
  { name: FOLDER, type: 'folder', id: '10', parent: ORG },
  { name: PROJECT_A, type: 'project', id: 'proj-a', projectNumber: '111', parent: FOLDER },
  { name: PROJECT_B, type: 'project', id: 'proj-b', projectNumber: '222', parent: ORG },
];

export const POOL = 'projects/111/locations/global/workloadIdentityPools/github';
export const REPO_PRINCIPAL = `principalSet://iam.googleapis.com/${POOL}/attribute.repository/org/repo`;
export const ALL_PRINCIPAL = `principalSet://iam.googleapis.com/${POOL}/*`;

export const sa = (name: string, project: 'a' | 'b' = 'a') => `${name}@proj-${project}.iam.gserviceaccount.com`;
export const saMember = (name: string, project: 'a' | 'b' = 'a') => `serviceAccount:${sa(name, project)}`;
export const saResource = (name: string, project: 'a' | 'b' = 'a') =>
  `//iam.googleapis.com/projects/proj-${project}/serviceAccounts/${sa(name, project)}`;

export const roles: Record<string, string[]> = {
  'roles/iam.workloadIdentityUser': ['iam.serviceAccounts.getAccessToken', 'iam.serviceAccounts.getOpenIdToken'],
  'roles/iam.serviceAccountTokenCreator': ['iam.serviceAccounts.getAccessToken', 'iam.serviceAccounts.signBlob'],
  'roles/iam.serviceAccountUser': ['iam.serviceAccounts.actAs', 'iam.serviceAccounts.get'],
  'roles/iam.serviceAccountKeyAdmin': ['iam.serviceAccountKeys.create', 'iam.serviceAccountKeys.delete'],
  'roles/storage.admin': ['storage.buckets.get', 'storage.objects.get'],
  'roles/viewer': ['resourcemanager.projects.get', 'storage.buckets.list'],
  'organizations/1/roles/customImpersonator': ['iam.serviceAccounts.getAccessToken'],
  'organizations/1/roles/customDeployer': ['run.services.create', 'iam.serviceAccounts.actAs'],
};

export function source(bindings: MemberBinding[]): StaticSourceData {
  return {
    containers,
    serviceAccounts: [
      { email: sa('deploy'), project: PROJECT_A },
      { email: sa('runtime'), project: PROJECT_A },
      { email: sa('admin', 'b'), project: PROJECT_B },
      { email: sa('other', 'b'), project: PROJECT_B },
    ],
    bindings,
    roles,
  };
}
