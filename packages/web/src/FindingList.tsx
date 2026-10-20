import type { Finding, Severity } from '@wif-viz/core';
import { shortResource, shortServiceAccount } from './view-graph.ts';

const SEVERITY_LABELS: Record<Severity, string> = { high: '高', medium: '中', low: '低' };

function causeLabel(finding: Finding): string {
  const ref = finding.cause.ref.includes('workloadIdentityPools/')
    ? finding.cause.ref.replace(/^.*workloadIdentityPools\//, '')
    : shortServiceAccount(finding.cause.ref);
  if (finding.cause.kind === 'binding') return `${ref} に ${finding.cause.role} @ ${shortResource(finding.cause.grantedOn ?? '')}`;
  if (finding.cause.kind === 'path') return finding.cause.ref.split('>').map((p) => shortServiceAccount(p.replace(/^.*workloadIdentityPools\//, ''))).join(' → ');
  return ref;
}

interface Props {
  findings: Finding[];
  selectedId: string | null;
  onSelect: (finding: Finding) => void;
  severityFilter: Set<Severity>;
  onToggleSeverity: (severity: Severity) => void;
}

export function FindingList({ findings, selectedId, onSelect, severityFilter, onToggleSeverity }: Props) {
  const visible = findings.filter((f) => severityFilter.has(f.severity));
  return (
    <div className="finding-list">
      <div className="severity-filter" role="group" aria-label="重要度で絞り込む">
        {(['high', 'medium', 'low'] as const).map((severity) => (
          <button
            key={severity}
            type="button"
            className={`chip severity-${severity}`}
            aria-pressed={severityFilter.has(severity)}
            onClick={() => onToggleSeverity(severity)}
          >
            {SEVERITY_LABELS[severity]} {findings.filter((f) => f.severity === severity).length}
          </button>
        ))}
      </div>
      {visible.length === 0 && <p className="empty">該当する項目はありません</p>}
      <ol>
        {visible.map((finding) => (
          <li key={finding.id}>
            <button type="button" className={`finding${finding.id === selectedId ? ' selected' : ''}`} onClick={() => onSelect(finding)}>
              <span className="finding-head">
                <span className={`badge severity-${finding.severity}`}>{SEVERITY_LABELS[finding.severity]}</span>
                <code className="rule-id">{finding.ruleId}</code>
              </span>
              <span className="finding-message">{finding.message}</span>
              <span className="finding-cause">{causeLabel(finding)}</span>
              <span className="finding-impact">
                Workload {finding.impact.workloads.length} / principal {finding.impact.principals.length} / リソース {finding.impact.resourceCount}
              </span>
              {finding.id === selectedId && <span className="finding-recommendation">対応: {finding.recommendation}</span>}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
