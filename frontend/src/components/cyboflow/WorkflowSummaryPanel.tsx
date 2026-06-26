import { useEffect, useMemo, useState } from 'react';
import { Flag, CheckCircle2, AlertTriangle, MessageSquarePlus } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useErrorStore } from '../../stores/errorStore';
import { cn } from '../../utils/cn';
import type { RunUsageRollup } from '../../../../shared/types/insights';

/** Mirror of ChatInput's interactive submit cadence: type, settle, then Enter. */
const SUBMIT_DELAY_MS = 300;

/** Compact token figure: >= 1M → 'N.Nm', >= 1k → 'Nk', else the integer. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

function formatCost(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

interface TokenCategory {
  key: string;
  label: string;
  value: number;
  /** Tailwind bg class for the proportion bar. */
  barClass: string;
}

interface WorkflowSummaryPanelProps {
  runId: string;
  /** The run's lifecycle status ('completed' | 'failed' | 'awaiting_review' | ...). */
  status?: string;
  /** 'sdk' | 'interactive' — the secondary CTA shows for interactive only. */
  substrate?: string;
  /** Human label for the finished flow (workflow name or run id fallback). */
  workflowLabel: string;
  /** Open the End-workflow confirm (RunEndDialog) — the primary "Complete" path. */
  onComplete: () => void;
}

/**
 * WorkflowSummaryPanel — the end-of-workflow center-pane module. Replaces the
 * all-steps-completed WorkflowCanvas (and the old "this workflow is finished"
 * banner) once a run is end-eligible (rested with no open gate, or
 * self-terminated). Shows the run's token usage broken down by category, then
 * two CTAs:
 *   - PRIMARY  "Complete workflow"  → onComplete (runs.end via RunEndDialog)
 *   - SECONDARY "Request changes"   → INTERACTIVE ONLY: relays feedback into the
 *     live PTY (runs.relayInput) so the user keeps working with the SAME agent.
 *     SDK runs have no live process to continue, so the CTA is hidden for them.
 */
export function WorkflowSummaryPanel({
  runId,
  status,
  substrate,
  workflowLabel,
  onComplete,
}: WorkflowSummaryPanelProps): React.JSX.Element {
  const [usage, setUsage] = useState<RunUsageRollup | null>(null);
  const [loading, setLoading] = useState(true);

  // "Request changes" inline composer (interactive only).
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeText, setChangeText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const isInteractive = substrate === 'interactive';
  const isFailed = status === 'failed';

  useEffect(() => {
    let alive = true;
    setLoading(true);
    trpc.cyboflow.insights.runUsage
      .query({ runId })
      .then((r) => {
        if (alive) {
          setUsage(r);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [runId]);

  const categories = useMemo<TokenCategory[]>(() => {
    if (usage === null) return [];
    return [
      { key: 'input', label: 'Input', value: usage.inputTokens, barClass: 'bg-interactive' },
      { key: 'output', label: 'Output', value: usage.outputTokens, barClass: 'bg-status-success' },
      { key: 'cache-write', label: 'Cache write', value: usage.cacheCreationTokens, barClass: 'bg-status-warning' },
      { key: 'cache-read', label: 'Cache read', value: usage.cacheReadTokens, barClass: 'bg-text-tertiary' },
    ];
  }, [usage]);

  const grandTotal = categories.reduce((sum, c) => sum + c.value, 0);
  const maxCategory = categories.reduce((m, c) => Math.max(m, c.value), 0);

  const handleSendChanges = async (): Promise<void> => {
    const text = changeText.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    try {
      // Same two-step relay ChatInput uses for the interactive substrate: write
      // the text, let the PTY settle, then send the Enter keystroke. The agent
      // resumes in the SAME live process; the run leaves awaiting_review and this
      // panel unmounts once the status subscription reports it running again.
      await trpc.cyboflow.runs.relayInput.mutate({ runId, text });
      await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
      await trpc.cyboflow.runs.relayInput.mutate({ runId, text: '\r' });
      setChangeText('');
      setSent(true);
    } catch (err: unknown) {
      useErrorStore.getState().showError({
        title: 'Request changes failed',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      data-testid="run-summary-panel"
      className="flex w-full max-w-2xl flex-col rounded-card border border-border-primary bg-surface-primary px-6 py-5 shadow-md"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
            isFailed ? 'bg-status-error/15 text-status-error' : 'bg-status-success/15 text-status-success',
          )}
        >
          {isFailed ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-text-primary">
            {isFailed ? 'Workflow stopped' : 'Workflow complete'}
          </h2>
          <p className="truncate text-sm text-text-secondary" title={workflowLabel}>
            {workflowLabel}
          </p>
        </div>
      </div>

      {/* Token usage breakdown */}
      <div className="mt-5">
        <div className="eyebrow mb-2 text-text-tertiary">Token usage by category</div>
        {loading ? (
          <p className="py-4 text-sm text-text-muted" data-testid="run-summary-loading">
            Tallying usage…
          </p>
        ) : grandTotal === 0 ? (
          <p className="py-4 text-sm text-text-muted" data-testid="run-summary-no-usage">
            No token usage was recorded for this run.
          </p>
        ) : (
          <div className="space-y-2" data-testid="run-summary-categories">
            {categories.map((c) => (
              <div key={c.key} className="flex items-center gap-3" data-testid={`run-summary-cat-${c.key}`}>
                <span className="w-24 flex-shrink-0 text-xs text-text-secondary">{c.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-secondary">
                  <div
                    className={cn('h-full rounded-full', c.barClass)}
                    style={{ width: maxCategory > 0 ? `${Math.max((c.value / maxCategory) * 100, c.value > 0 ? 2 : 0)}%` : '0%' }}
                  />
                </div>
                <span className="w-14 flex-shrink-0 text-right text-xs font-medium tabular-nums text-text-primary">
                  {compactTokens(c.value)}
                </span>
              </div>
            ))}

            {/* Totals row */}
            <div className="mt-1 flex items-center gap-3 border-t border-border-primary pt-2">
              <span className="w-24 flex-shrink-0 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                Total
              </span>
              <span className="flex-1 text-xs text-text-tertiary">tokens processed</span>
              <span
                className="w-14 flex-shrink-0 text-right text-sm font-bold tabular-nums text-text-primary"
                data-testid="run-summary-total"
              >
                {compactTokens(grandTotal)}
              </span>
            </div>

            {/* Meta line */}
            <div className="pt-1 text-xs text-text-secondary" data-testid="run-summary-meta">
              cost {formatCost(usage?.costUsd ?? null)}
              {usage?.numTurns != null && <> · {usage.numTurns} turns</>}
              {usage != null && usage.assistantMessageCount > 0 && <> · {usage.assistantMessageCount} messages</>}
            </div>
          </div>
        )}
      </div>

      {/* CTAs */}
      <div className="mt-auto pt-5">
        {sent ? (
          <p className="text-sm text-text-secondary" data-testid="run-summary-sent">
            Sent — continuing with the agent…
          </p>
        ) : changeOpen ? (
          <div className="space-y-2" data-testid="run-summary-change-composer">
            <textarea
              data-testid="run-summary-change-text"
              value={changeText}
              onChange={(e) => setChangeText(e.target.value)}
              placeholder="Describe the changes for the agent to make…"
              rows={3}
              autoFocus
              className="w-full resize-none rounded-card border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-border-emphasized focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="run-summary-change-send"
                onClick={() => void handleSendChanges()}
                disabled={sending || changeText.trim().length === 0}
                className="inline-flex items-center gap-1.5 rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send to agent'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setChangeOpen(false);
                  setChangeText('');
                }}
                className="rounded-button px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="run-summary-complete"
              onClick={onComplete}
              className="inline-flex items-center gap-1.5 rounded-button bg-interactive px-4 py-2 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover"
            >
              <Flag size={15} />
              Complete workflow
            </button>
            {isInteractive && (
              <button
                type="button"
                data-testid="run-summary-request-changes"
                onClick={() => setChangeOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-button border border-border-primary px-4 py-2 text-sm font-medium text-text-secondary hover:border-border-emphasized hover:text-text-primary"
                title="Keep working with the same agent — your feedback is sent into the live session"
              >
                <MessageSquarePlus size={15} />
                Request changes
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
