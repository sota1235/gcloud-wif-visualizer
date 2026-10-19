import type { Container, FullResourceName, Member, MemberBinding } from './types.ts';

/**
 * 探索に必要なデータの取得口。collector は GCP API で、テストはメモリ上のデータで実装する。
 */
export interface AccessSource {
  /** Org 全体から、member に付与されたバインディングを返す */
  bindingsForMember(member: Member): Promise<MemberBinding[]>;
  /** ロールに含まれる permission を返す（カスタムロールを含む） */
  rolePermissions(role: string): Promise<string[]>;
  /** container 配下（子孫を含む）の SA の email を返す */
  serviceAccountsUnder(container: FullResourceName): Promise<string[]>;
}

export interface StaticServiceAccount {
  email: string;
  /** SA が属する project の full resource name */
  project: FullResourceName;
}

export interface StaticSourceData {
  containers: Container[];
  serviceAccounts: StaticServiceAccount[];
  bindings: MemberBinding[];
  roles: Record<string, string[]>;
}

/** container の祖先（自身を含む）を返す */
export function containerAncestors(containers: Map<FullResourceName, Container>, name: FullResourceName): FullResourceName[] {
  const ancestors: FullResourceName[] = [];
  let current: FullResourceName | undefined = name;
  while (current && !ancestors.includes(current)) {
    ancestors.push(current);
    current = containers.get(current)?.parent;
  }
  return ancestors;
}

/** メモリ上のデータから AccessSource を作る（テスト、オフライン再計算用） */
export function createStaticSource(data: StaticSourceData): AccessSource {
  const containers = new Map(data.containers.map((c) => [c.name, c]));
  return {
    async bindingsForMember(member) {
      return data.bindings.filter((b) => b.member === member);
    },
    async rolePermissions(role) {
      const permissions = data.roles[role];
      if (!permissions) throw new Error(`unknown role: ${role}`);
      return permissions;
    },
    async serviceAccountsUnder(container) {
      return data.serviceAccounts
        .filter((sa) => containerAncestors(containers, sa.project).includes(container))
        .map((sa) => sa.email);
    },
  };
}
