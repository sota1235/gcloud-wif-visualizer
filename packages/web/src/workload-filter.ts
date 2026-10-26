import type { Member, ResourceMatch, Snapshot } from '@wif-viz/core';
import { matchesTerms } from './role-search.ts';
import type { ViewGraph, ViewNode } from './view-graph.ts';

/** ワークロードの絞り込みで照合する文字列（ラベル、principal、Provider、claim の制約の値） */
export function workloadSearchText(node: ViewNode): string {
  const parts = [node.label];
  if (node.source?.kind === 'workload') {
    const { workload } = node.source;
    parts.push(workload.principal, workload.provider, ...workload.constraints.flatMap((c) => [c.claim, ...c.values]));
  }
  return parts.join('\n');
}

/** 空白区切りのすべての語を含むワークロードに絞り込む。空の場合はすべて返す */
export function filterWorkloads(workloads: ViewNode[], query: string): ViewNode[] {
  return query.trim() === '' ? workloads : workloads.filter((w) => matchesTerms(workloadSearchText(w), query));
}

/**
 * リソースに到達できるワークロードの ID。
 * リソースそのものへの付与と、祖先の container への付与のうちそのアセットタイプに届くもの（実効アクセス）から判定する。
 */
export function workloadsReachingResource(snapshot: Pick<Snapshot, 'effectiveAccess'>, view: ViewGraph, resource: ResourceMatch): Set<string> {
  const ancestors = new Set(resource.ancestors);
  const principals = new Set(
    snapshot.effectiveAccess
      .filter((row) =>
        row.grantedOnKind === 'resource' ? row.grantedOn === resource.name : ancestors.has(row.grantedOn) && row.assetTypes.includes(resource.assetType),
      )
      .map((row) => row.principal),
  );
  return workloadsOfPrincipals(view, principals);
}

/** principal のいずれかに解決されるワークロードの ID */
export function workloadsOfPrincipals(view: ViewGraph, principals: Set<Member>): Set<string> {
  return new Set(view.edges.filter((e) => e.kind === 'resolves' && principals.has(e.target)).map((e) => e.source));
}
