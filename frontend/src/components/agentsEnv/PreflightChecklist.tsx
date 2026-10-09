import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Clock, Loader2, Minus, X } from 'lucide-react';
import type { CheckStatus, PreflightCheckResult } from '../../../../shared/types/hosts';
import { CopyButton } from './CopyButton';

const GLYPH: Record<CheckStatus, { icon: React.ReactNode; label: string }> = {
  pass: { icon: <Check className="h-3.5 w-3.5 text-status-success" aria-hidden />, label: 'Passed' },
  warn: { icon: <AlertTriangle className="h-3.5 w-3.5 text-status-warning" aria-hidden />, label: 'Warning' },
  fail: { icon: <X className="h-3.5 w-3.5 text-status-error" aria-hidden />, label: 'Failed' },
  na: { icon: <Minus className="h-3.5 w-3.5 text-text-tertiary" aria-hidden />, label: 'Not applicable' },
  skipped: { icon: <Clock className="h-3.5 w-3.5 text-text-tertiary" aria-hidden />, label: 'Arrives later' },
};

/** "9 passed · 2 warnings · 2 arrive later"; failures lead when present. Pure. */
export function summarizeChecks(results: readonly PreflightCheckResult[]): string {
  const n = (s: CheckStatus): number => results.filter((r) => r.status === s).length;
  const parts: string[] = [];
  if (n('fail') > 0) parts.push(`${n('fail')} failed`);
  if (n('pass') > 0) parts.push(`${n('pass')} passed`);
  if (n('warn') > 0) parts.push(`${n('warn')} ${n('warn') === 1 ? 'warning' : 'warnings'}`);
  if (n('skipped') > 0) parts.push(`${n('skipped')} arrive later`);
  return parts.length > 0 ? parts.join(' · ') : 'No checks yet';
}

/** One row per preflight check: status glyph, label, detail and a copyable fix. Collapsed to a summary. */
export function PreflightChecklist({
  hostId,
  results,
  running,
}: {
  hostId: string;
  results: readonly PreflightCheckResult[];
  running: boolean;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (results.length === 0 && !running) return null;
  const expanded = open || running;
  return (
    <div data-testid={`preflight-checklist-${hostId}`} className="flex flex-col gap-1.5">
      <button
        type="button"
        data-testid={`preflight-toggle-${hostId}`}
        aria-expanded={expanded}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-left text-[11px] text-text-secondary hover:text-text-primary"
      >
        {expanded ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
        <span data-testid={`preflight-summary-${hostId}`}>
          {running && results.length === 0 ? 'Checking…' : summarizeChecks(results)}
        </span>
        {running && <Loader2 className="h-3 w-3 animate-spin text-text-tertiary" aria-hidden />}
      </button>
      {expanded && (
        <ul className="flex flex-col gap-1.5">
          {results.map((r) => (
            <li
              key={r.id}
              data-testid={`preflight-row-${r.id}`}
              data-status={r.status}
              className="flex items-start gap-2 border border-border-primary bg-surface-primary px-2.5 py-1.5"
            >
              <span className="mt-px shrink-0" role="img" aria-label={GLYPH[r.status].label} title={GLYPH[r.status].label}>
                {GLYPH[r.status].icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-bold text-text-primary">{r.label}</div>
                <div className="break-words text-[10px] text-text-tertiary">{r.detail}</div>
                {r.fix !== undefined && r.fix !== '' && (
                  <div className="mt-1 flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all border border-border-primary bg-bg-primary px-1 text-[10px] text-text-secondary">
                      {r.fix}
                    </code>
                    <CopyButton text={r.fix} label="Copy fix" testId={`preflight-copy-${r.id}`} />
                  </div>
                )}
              </div>
            </li>
          ))}
          {running && (
            <li className="flex items-center gap-2 px-2.5 py-1 text-[10px] text-text-tertiary">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Checking…
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
