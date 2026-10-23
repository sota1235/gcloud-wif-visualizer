import { ResourceList } from './ResourceList.tsx';
import type { ViewNode } from './view-graph.ts';
import { shortResource } from './view-graph.ts';

interface Props {
  node: ViewNode;
  /** このノード（identity）が持つロールの付与先 */
  grants: ViewNode[];
  onFocus: (id: string) => void;
  onClose: () => void;
}

export function DetailPanel({ node, grants, onFocus, onClose }: Props) {
  const source = node.source;
  return (
    <aside className="detail-panel" aria-label="ノードの詳細">
      <div className="detail-head">
        <strong>{node.label}</strong>
        <button type="button" className="link" onClick={onClose} aria-label="詳細を閉じる">
          閉じる
        </button>
      </div>
      <button type="button" className="primary" onClick={() => onFocus(node.id)}>
        このノードを中心に表示
      </button>

      {source?.kind === 'workload' && (
        <dl>
          <dt>Provider</dt>
          <dd><code>{source.workload.provider}</code></dd>
          <dt>推定の確度</dt>
          <dd>{source.workload.confidence === 'exact' ? 'すべて解釈できた' : '一部のみ解釈できた'}</dd>
          <dt>制約</dt>
          <dd>
            <ul>
              {source.workload.constraints.map((c, i) => (
                <li key={i}>
                  <code>{c.claim}</code> {c.op} {c.values.join(', ')}（{c.source === 'principal' ? 'principal' : 'condition'}）
                </li>
              ))}
            </ul>
          </dd>
          {source.workload.unparsedConditions.length > 0 && (
            <>
              <dt>解釈できなかった条件</dt>
              <dd>{source.workload.unparsedConditions.map((c) => <code key={c}>{c}</code>)}</dd>
            </>
          )}
        </dl>
      )}

      {(source?.kind === 'principal' || source?.kind === 'serviceAccount') && (
        <dl>
          <dt>ID</dt>
          <dd><code className="wrap">{source.id}</code></dd>
          <dt>ロールの付与（{grants.length} 件）</dt>
          <dd>
            {grants.length === 0 ? (
              <span className="muted">なし（SA への impersonation / actAs 以外）</span>
            ) : (
              <ul>
                {grants.map((g) => (
                  <li key={g.id}>
                    <code className="wrap">{shortResource(g.grantedOn ?? '')}</code>
                    <span className="muted"> {g.roles?.map((r) => r.replace(/^roles\//, '')).join(', ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      )}

      {node.type === 'grant' && (
        <dl>
          <dt>付与箇所</dt>
          <dd><code className="wrap">{node.grantedOn}</code></dd>
          <dt>ロール</dt>
          <dd><ul>{node.roles?.map((r) => <li key={r}><code>{r}</code></li>)}</ul></dd>
        </dl>
      )}

      {node.type === 'resourceGroup' && (
        <dl>
          <dt>付与箇所</dt>
          <dd><code className="wrap">{node.grantedOn}</code></dd>
          <dt>アセットタイプ</dt>
          <dd><code>{node.assetType}</code></dd>
          <dt>操作できるロール</dt>
          <dd><ul>{node.roles?.map((r) => <li key={r}><code>{r}</code></li>)}</ul></dd>
          <dt>リソース（{node.resourceCount} 件）</dt>
          <dd>
            <ResourceList container={node.grantedOn ?? ''} assetType={node.assetType ?? ''} />
          </dd>
        </dl>
      )}
    </aside>
  );
}
