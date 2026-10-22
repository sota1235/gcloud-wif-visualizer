import { matchesTerms } from './role-search.ts';
import type { ViewNode } from './view-graph.ts';

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
