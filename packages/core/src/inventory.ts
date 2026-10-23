import type { AccessTarget, Container, FullResourceName, InventoryResource, ResourceCounts, TargetResource } from './types.ts';

/** インベントリの `ancestors` と照合するための container のキー（`projects/{number}` など） */
export function containerKey(container: Container): string {
  if (container.type === 'project') return `projects/${container.projectNumber ?? container.id}`;
  return `${container.type === 'folder' ? 'folders' : 'organizations'}/${container.id}`;
}

/** 名前で探したリソース。ancestors は Org 内の祖先の container */
export interface ResourceMatch extends TargetResource {
  name: FullResourceName;
}

/** 検索で並べ替えの対象にする一致の上限 */
const SEARCH_CANDIDATES = 5000;

/**
 * 展開対象のアセットタイプのインベントリ。
 * container × アセットタイプで索引を作り、配下のリソースの一覧と件数を引けるようにする。
 */
export class ResourceInventory implements Iterable<InventoryResource> {
  readonly #byName = new Map<FullResourceName, InventoryResource>();
  readonly #index = new Map<string, FullResourceName[]>();
  readonly #sorted = new Set<string>();
  readonly #containerByKey: Map<string, FullResourceName>;

  constructor(containers: Container[], resources: Iterable<InventoryResource> = []) {
    this.#containerByKey = new Map(containers.map((c) => [containerKey(c), c.name]));
    for (const resource of resources) this.add(resource);
  }

  add(resource: InventoryResource): void {
    if (this.#byName.has(resource.name)) return;
    this.#byName.set(resource.name, resource);
    for (const container of this.ancestorsOf(resource)) {
      const key = `${container}|${resource.assetType}`;
      const list = this.#index.get(key);
      if (list) {
        list.push(resource.name);
        this.#sorted.delete(key);
      } else {
        this.#index.set(key, [resource.name]);
      }
    }
  }

  get size(): number {
    return this.#byName.size;
  }

  get(name: FullResourceName): InventoryResource | undefined {
    return this.#byName.get(name);
  }

  /** 祖先の container の full resource name（Org 外の container は含まない） */
  ancestorsOf(resource: InventoryResource): FullResourceName[] {
    return resource.ancestors.map((key) => this.#containerByKey.get(key)).filter((c): c is FullResourceName => c !== undefined);
  }

  /** container 配下（子孫の container を含む）の、指定したアセットタイプのリソースを名前順に返す */
  list(container: FullResourceName, assetType: string): readonly FullResourceName[] {
    const key = `${container}|${assetType}`;
    const list = this.#index.get(key);
    if (!list) return [];
    if (!this.#sorted.has(key)) {
      list.sort();
      this.#sorted.add(key);
    }
    return list;
  }

  /** 実効アクセスが到達できるリソースを名前順に返す */
  listTarget(target: AccessTarget): FullResourceName[] {
    if (target.grantedOnKind === 'resource') return [target.grantedOn];
    return target.assetTypes.flatMap((type) => this.list(target.grantedOn, type)).sort();
  }

  /** container → アセットタイプ → 配下のリソース数 */
  resourceCounts(): ResourceCounts {
    const counts: ResourceCounts = {};
    for (const [key, list] of [...this.#index].sort(([a], [b]) => a.localeCompare(b))) {
      const separator = key.lastIndexOf('|');
      const container = key.slice(0, separator);
      (counts[container] ??= {})[key.slice(separator + 1)] = list.length;
    }
    return counts;
  }

  /**
   * 名前に空白区切りのすべての語を含むリソースを探す（大文字小文字を区別しない）。
   * 短い名前ほど指定したリソースそのものである可能性が高いため、名前の短い順に返す。
   */
  search(query: string, limit: number): { total: number; items: ResourceMatch[] } {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return { total: 0, items: [] };
    let total = 0;
    const candidates: FullResourceName[] = [];
    for (const name of this.#byName.keys()) {
      const lower = name.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      total++;
      // 一致が非常に多い場合に、すべてを保持して並べ替えないようにする
      if (candidates.length < SEARCH_CANDIDATES) candidates.push(name);
    }
    const items = candidates
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, limit)
      .map((name) => ({ name, ...this.targetResource(name)! }));
    return { total, items };
  }

  targetResource(name: FullResourceName): TargetResource | undefined {
    const resource = this.#byName.get(name);
    return resource ? { assetType: resource.assetType, ancestors: this.ancestorsOf(resource) } : undefined;
  }

  [Symbol.iterator](): Iterator<InventoryResource> {
    return this.#byName.values();
  }
}
