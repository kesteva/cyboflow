import { useEffect, useMemo, useState } from 'react';
import {
  Flag,
  CheckCircle2,
  AlertTriangle,
  MessageSquarePlus,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useErrorStore } from '../../stores/errorStore';
import { cn } from '../../utils/cn';
import type { RunUsageRollup, RunEval } from '../../../../shared/types/insights';
import type { ReviewItem } from '../../../../shared/types/reviews';
import {
  bandDisplay,
  scoreToBand,
  gateStatus,
  formatRuntime,
  FINDING_SEVERITY_LABEL,
  RUBRIC_DIMENSION_COUNT,
  GATE_KEYS,
  type GateStatus,
} from './runEvalDisplay';

/** Mirror of ChatInput's interactive submit cadence: type, settle, then Enter. */
const SUBMIT_DELAY_MS = 300;

/** How often to re-poll the eval while it is pending/running. */
const EVAL_POLL_MS = 10_000;

/**
 * How many times to keep polling on a NULL eval before giving up. The snapshot row
 * lands only AFTER an async git-diff capture, so a panel mounted right at the
 * human-review trigger can see null for a few seconds — but a genuinely eval-less
 * run (planner/compound, custom flows) is null forever, so the null-retry is
 * bounded rather than infinite.
 */
const MAX_NULL_POLLS = 12;

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

/** One eval-authored finding flattened for display (severity chip + file:line + text). */
interface FindingRow {
  id: string;
  severity: 'info' | 'warning' | 'error';
  /** 'path:line' when a location is present, else null. */
  location: string | null;
  /** Optional grouping tag (finding payload `category`); null when absent. */
  category: string | null;
  title: string;
}

/** Extract the first file:line location off a finding's parsed payload, if any. */
function findingLocation(item: ReviewItem): string | null {
  const payload = item.payload;
  if (payload === null || payload.kind !== 'finding') return null;
  const loc = payload.locations?.[0];
  if (loc === undefined) return null;
  return loc.line === undefined ? loc.path : `${loc.path}:${loc.line}`;
}

/** The finding's optional grouping category (payload `category`), if any. */
function findingCategory(item: ReviewItem): string | null {
  const payload = item.payload;
  if (payload === null || payload.kind !== 'finding') return null;
  return payload.category ?? null;
}

/** Severity → chip surface (background + text) tokens. `info`/NIT reads neutral. */
const SEVERITY_CHIP: Record<'info' | 'warning' | 'error', string> = {
  info: 'bg-surface-secondary text-text-tertiary',
  warning: 'bg-status-warning/15 text-status-warning',
  error: 'bg-status-error/15 text-status-error',
};

/** Severity → chip status dot color. */
const SEVERITY_DOT: Record<'info' | 'warning' | 'error', string> = {
  info: 'bg-text-tertiary',
  warning: 'bg-status-warning',
  error: 'bg-status-error',
};

/** Gate status → chip status dot color (the chip surface itself stays neutral). */
const GATE_DOT: Record<GateStatus, string> = {
  pass: 'bg-status-success',
  fail: 'bg-status-error',
  unknown: 'bg-text-tertiary',
};

interface WorkflowSummaryPanelProps {
  runId: string;
  /** Owning project — enables the eval's net-new findings drill-down. */
  projectId?: number | null;
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
 * self-terminated). Shows the run's token usage broken down by category, an
 * optional advisory quality Score-summary (code-review eval), then two CTAs:
 *   - PRIMARY  "Complete workflow"  → onComplete (runs.end via RunEndDialog)
 *   - SECONDARY "Request changes"   → INTERACTIVE ONLY: relays feedback into the
 *     live PTY (runs.relayInput) so the user keeps working with the SAME agent.
 *     SDK runs have no live process to continue, so the CTA is hidden for them.
 */
export function WorkflowSummaryPanel({
  runId,
  projectId,
  status,
  substrate,
  workflowLabel,
  onComplete,
}: WorkflowSummaryPanelProps): React.JSX.Element {
  const [usage, setUsage] = useState<RunUsageRollup | null>(null);
  const [loading, setLoading] = useState(true);

  // Advisory quality eval (null = no eval row → section absent entirely).
  const [runEval, setRunEval] = useState<RunEval | null>(null);
  const [findings, setFindings] = useState<FindingRow[]>([]);
  const [breakdownOpen, setBreakdownOpen] = useState(false);

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

  // Poll the eval while it is pending/running; stop on complete/failed/unmount. A
  // null response is retried a bounded number of times (MAX_NULL_POLLS) so a panel
  // mounted inside the snapshot-capture window still picks up the row once it lands,
  // without polling forever for a genuinely eval-less run.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nullPolls = 0;
    const tick = (): void => {
      trpc.cyboflow.insights.runEval
        .query({ runId })
        .then((r) => {
          if (!alive) return;
          setRunEval(r);
          const inProgress =
            r !== null && (r.evalStatus === 'pending' || r.evalStatus === 'running');
          if (r === null) nullPolls += 1;
          if (inProgress || (r === null && nullPolls < MAX_NULL_POLLS)) {
            timer = setTimeout(tick, EVAL_POLL_MS);
          }
        })
        .catch(() => {
          /* leave the last-known eval state; a transient read error is non-fatal */
        });
    };
    tick();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId]);

  // The eval's net-new findings (advisory drill-down). Needs the owning project;
  // filtered to eval-authored findings (source 'agent:eval*') so the panel does
  // not surface a Sprint agent's own findings here.
  useEffect(() => {
    if (projectId === undefined || projectId === null) return;
    if (runEval === null || runEval.evalStatus !== 'complete') return;
    let alive = true;
    trpc.cyboflow.reviewItems.list
      .query({ projectId, kind: 'finding', runId })
      .then((items) => {
        if (!alive) return;
        const rows: FindingRow[] = items
          .filter((it) => (it.source ?? '').startsWith('agent:eval'))
          .map((it) => ({
            id: it.id,
            severity: it.severity ?? 'info',
            location: findingLocation(it),
            category: findingCategory(it),
            title: it.title,
          }));
        setFindings(rows);
      })
      .catch(() => {
        /* findings are advisory; a read error just leaves the list empty */
      });
    return () => {
      alive = false;
    };
  }, [projectId, runId, runEval]);

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

  const runtime = usage === null ? null : formatRuntime(usage.startedAt, usage.endedAt);

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

      {/* Token usage breakdown (Run summary) */}
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
              {runtime !== null && <> · runtime {runtime}</>}
            </div>
          </div>
        )}
      </div>

      {/* Score summary (advisory code-review eval) */}
      {runEval !== null && (
        <ScoreSummary
          runEval={runEval}
          findings={findings}
          breakdownOpen={breakdownOpen}
          onToggleBreakdown={() => setBreakdownOpen((v) => !v)}
        />
      )}

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
        {runEval !== null && (
          <p className="mt-2 text-xs text-text-muted" data-testid="run-summary-eval-advisory">
            Assessment is advisory — only a confirmed critical finding blocks completion.
          </p>
        )}
      </div>
    </div>
  );
}

interface ScoreSummaryProps {
  runEval: RunEval;
  findings: FindingRow[];
  breakdownOpen: boolean;
  onToggleBreakdown: () => void;
}

/**
 * The advisory Score-summary module. In-progress and failed states collapse to a
 * single muted line; the complete state renders a bordered module: an eyebrow +
 * deterministic-gate chip header, a two-column band-first hero (band word +
 * score + provenance on the left, sample-spread scale + gate chips on the
 * right), and an expandable per-dimension + findings breakdown. The GATED
 * sentinel replaces the numeric hero when a deterministic gate failed.
 */
function ScoreSummary({ runEval, findings, breakdownOpen, onToggleBreakdown }: ScoreSummaryProps): React.JSX.Element {
  if (runEval.evalStatus === 'pending' || runEval.evalStatus === 'running') {
    return (
      <p className="mt-5 text-sm text-text-muted" data-testid="run-summary-eval-progress">
        Quality assessment running…
      </p>
    );
  }
  if (runEval.evalStatus === 'failed') {
    return (
      <p className="mt-5 text-sm text-text-muted" data-testid="run-summary-eval-failed">
        Quality assessment unavailable.
      </p>
    );
  }

  const dimensions = runEval.dimensions ?? [];
  const activeCount = dimensions.filter((d) => d.active).length;
  const band = runEval.band;
  const gatePassed = !runEval.gated;

  return (
    <div className="mt-5 rounded-card border border-border-primary bg-surface-secondary/30 p-4" data-testid="run-summary-eval">
      {/* Eyebrow + deterministic-gate sentinel chip */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="eyebrow text-text-tertiary" data-testid="run-summary-eval-eyebrow">
          Score summary — rubric v{runEval.rubricVersion}
        </span>
        <span
          data-testid="run-summary-eval-gate-summary"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold',
            gatePassed
              ? 'border-status-success/40 bg-status-success/15 text-status-success'
              : 'border-status-error/40 bg-status-error/15 text-status-error',
          )}
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', gatePassed ? 'bg-status-success' : 'bg-status-error')} />
          Deterministic gate: {gatePassed ? 'PASSED' : 'GATED'}
        </span>
      </div>

      {runEval.gated ? (
        <div className="space-y-4">
          <GatedHero />
          <Provenance runEval={runEval} />
          <GateStrip gateResults={runEval.gateResults} activeCount={activeCount} />
        </div>
      ) : band !== null ? (
        <div className="flex flex-col gap-6 md:flex-row md:items-start" data-testid="run-summary-eval-hero">
          <ScoreLede band={band} overallScore={runEval.overallScore} runEval={runEval} />
          <div className="min-w-0 flex-1">
            {runEval.overallScore !== null && (
              <CiScale score={runEval.overallScore} ciLow={runEval.ciLow} ciHigh={runEval.ciHigh} band={band} />
            )}
            <GateStrip gateResults={runEval.gateResults} activeCount={activeCount} />
          </div>
        </div>
      ) : null}

      {/* Breakdown toggle — full-width bar with a top divider */}
      <div className="mt-5 border-t border-border-primary pt-4">
        <button
          type="button"
          data-testid="run-summary-eval-toggle"
          aria-expanded={breakdownOpen}
          onClick={onToggleBreakdown}
          className="flex w-full items-center justify-between gap-2 rounded-button border border-border-primary bg-surface-primary px-4 py-2.5 text-left text-sm font-medium text-text-secondary hover:border-border-emphasized hover:text-text-primary"
        >
          <span>
            {breakdownOpen ? (
              'Hide breakdown & findings'
            ) : (
              <>
                Show {RUBRIC_DIMENSION_COUNT}-dimension breakdown &amp; {findings.length}{' '}
                {findings.length === 1 ? 'finding' : 'findings'}
              </>
            )}
          </span>
          {breakdownOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>

      {breakdownOpen && (
        <div className="mt-4" data-testid="run-summary-eval-breakdown">
          <div className="eyebrow mb-3 text-text-tertiary">Per-dimension sub-scores · weighted</div>
          <div>
            {dimensions.map((d) => {
              const dBand = d.score !== null ? scoreToBand(d.score) : null;
              const dbd = dBand !== null ? bandDisplay(dBand) : null;
              return (
                <div
                  key={d.key}
                  className={cn(
                    'grid grid-cols-[minmax(0,1fr)_auto_2fr_auto_auto] items-center gap-3 border-b border-border-primary/50 py-2 last:border-b-0',
                    !d.active && 'opacity-40',
                  )}
                  data-testid={`run-summary-eval-dim-${d.key}`}
                >
                  <span className="truncate text-xs text-text-primary" title={d.name}>
                    {d.name}
                  </span>
                  <span className="w-9 text-right text-[11px] tabular-nums text-text-tertiary">
                    {Math.round(d.weight)}%
                  </span>
                  <div className="h-2 overflow-hidden rounded-full bg-surface-secondary">
                    <div
                      className={cn('h-full rounded-full', dbd?.bgClass ?? 'bg-text-tertiary')}
                      style={{ width: d.score !== null ? `${Math.max(d.score, 0)}%` : '0%' }}
                    />
                  </div>
                  <span className="w-8 text-right text-xs font-bold tabular-nums text-text-primary">
                    {!d.active ? 'inactive' : d.score !== null ? d.score : '—'}
                  </span>
                  <span
                    className={cn(
                      'w-16 text-right text-[10px] font-semibold uppercase tracking-wide',
                      dbd?.textClass ?? 'text-text-tertiary',
                    )}
                  >
                    {d.active && dBand !== null ? dBand : ''}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Net-new findings */}
          {findings.length > 0 && (
            <div className="mt-5 border-t border-border-primary pt-4" data-testid="run-summary-eval-findings">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <h4 className="text-sm font-bold text-text-primary">Complete assessment</h4>
                <span className="eyebrow text-text-tertiary">
                  {findings.length} net-new {findings.length === 1 ? 'finding' : 'findings'}
                </span>
              </div>
              <p className="mb-2 text-[11px] leading-relaxed text-text-tertiary">
                The independent judge caught these — the flow&apos;s own code-review missed them. Deduped,
                tagged with severity, and routed to your review queue.
              </p>
              <div>
                {findings.map((f, i) => (
                  <div
                    key={f.id}
                    className="grid grid-cols-[auto_1fr] gap-3 border-t border-border-primary/60 py-3 first:border-t-0"
                    data-testid="run-summary-eval-finding"
                  >
                    <span
                      className={cn(
                        'mt-0.5 inline-flex h-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                        SEVERITY_CHIP[f.severity],
                      )}
                    >
                      <span className={cn('h-1.5 w-1.5 rounded-full', SEVERITY_DOT[f.severity])} />
                      {FINDING_SEVERITY_LABEL[f.severity]}
                    </span>
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="text-[11px] font-bold tabular-nums text-text-tertiary">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        {f.category !== null && (
                          <span className="text-[11px] font-semibold text-text-secondary">{f.category}</span>
                        )}
                      </div>
                      <div className="text-xs leading-relaxed text-text-primary">{f.title}</div>
                      {f.location !== null && (
                        <span className="mt-1.5 inline-block rounded-button border border-border-primary bg-surface-secondary px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-interactive">
                          {f.location}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Left column of the hero: huge band word, score / 100, then the provenance block. */
function ScoreLede({
  band,
  overallScore,
  runEval,
}: {
  band: NonNullable<RunEval['band']>;
  overallScore: number | null;
  runEval: RunEval;
}): React.JSX.Element {
  const bd = bandDisplay(band);
  return (
    <div className="flex-shrink-0 md:min-w-[12rem]">
      <div
        className={cn('text-4xl font-bold leading-none tracking-tight', bd.textClass)}
        data-testid="run-summary-eval-band"
      >
        {bd.label}
      </div>
      {overallScore !== null && (
        <div className="mt-2 text-sm text-text-secondary" data-testid="run-summary-eval-score">
          <span className="font-bold tabular-nums text-text-primary">{overallScore}</span> / 100 · overall
        </div>
      )}
      <Provenance runEval={runEval} />
    </div>
  );
}

/** The 3-line provenance block (judge/samples, jury descriptor, security + caps). */
function Provenance({ runEval }: { runEval: RunEval }): React.JSX.Element {
  return (
    <div className="mt-3 space-y-0.5 text-[11px] leading-relaxed text-text-tertiary" data-testid="run-summary-eval-provenance">
      <div>
        graded by{' '}
        <span className="font-medium text-text-secondary">
          {runEval.judgeModel ?? 'unknown'}
          {runEval.sampleCount != null && <> ×{runEval.sampleCount}</>}
        </span>{' '}
        samples
      </div>
      <div>pluggable jury · single-family v1</div>
      <div>
        security_flag: <span className="font-medium text-text-secondary">{runEval.securityFlag ? 'high/critical' : 'none'}</span>
        {runEval.capTriggers !== null && (
          <span data-testid="run-summary-eval-capped"> · capped: {runEval.capTriggers.join(', ')}</span>
        )}
      </div>
    </div>
  );
}

/** The deterministic-gate chip strip plus the active-dimension count chip. */
function GateStrip({
  gateResults,
  activeCount,
}: {
  gateResults: Record<string, unknown> | null;
  activeCount: number;
}): React.JSX.Element {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5" data-testid="run-summary-eval-gates">
      {GATE_KEYS.map((key) => {
        const st = gateStatus((gateResults ?? {})[key]);
        return (
          <span
            key={key}
            data-testid={`run-summary-eval-gate-${key}`}
            data-gate-status={st}
            title={`${key}: ${st}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-border-primary bg-surface-primary px-2 py-0.5 text-[11px] font-medium text-text-secondary"
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', GATE_DOT[st])} />
            {key}
          </span>
        );
      })}
      <span
        data-testid="run-summary-eval-dims-active"
        className="inline-flex items-center gap-1.5 rounded-full border border-border-primary bg-surface-primary px-2 py-0.5 text-[11px] font-medium text-text-tertiary"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-text-tertiary" />
        {activeCount} / {RUBRIC_DIMENSION_COUNT} dimensions active
      </span>
    </div>
  );
}

/** The GATED sentinel — replaces the numeric hero when a deterministic gate failed. */
function GatedHero(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2" data-testid="run-summary-eval-gated">
      <ShieldAlert size={20} className="flex-shrink-0 text-status-error" />
      <div>
        <div className="text-lg font-bold tracking-tight text-status-error">GATED</div>
        <p className="text-xs text-text-secondary">A deterministic gate failed — no quality score is assigned.</p>
      </div>
    </div>
  );
}

/**
 * Sample-spread scale: a 0–100 track with the sample-spread interval highlighted
 * in the band color, a marker at the point score (score labeled above it),
 * 0/25/50/75/100 axis ticks, and an explanatory note. Deliberately labeled
 * "Sample spread" — the backend computes a naive min/max sample spread, NOT a
 * statistical confidence interval.
 */
function CiScale({
  score,
  ciLow,
  ciHigh,
  band,
}: {
  score: number;
  ciLow: number | null;
  ciHigh: number | null;
  band: NonNullable<RunEval['band']>;
}): React.JSX.Element {
  const bd = bandDisplay(band);
  const clamp = (n: number): number => Math.min(100, Math.max(0, n));
  const lo = ciLow !== null ? clamp(ciLow) : null;
  const hi = ciHigh !== null ? clamp(ciHigh) : null;
  const hasRange = lo !== null && hi !== null && hi >= lo;
  return (
    <div data-testid="run-summary-eval-ci">
      <div className="mb-6 flex items-baseline justify-between gap-2">
        <span className="eyebrow text-text-tertiary">Sample spread</span>
        {hasRange && (
          <span className="text-xs tabular-nums text-text-secondary">
            <span className="font-semibold text-text-primary">{lo}</span> – <span className="font-semibold text-text-primary">{hi}</span>
          </span>
        )}
      </div>
      <div className="relative h-2.5 w-full rounded-full bg-surface-secondary">
        {hasRange && (
          <div
            className={cn('absolute inset-y-0 rounded-full opacity-40', bd.bgClass)}
            style={{ left: `${lo}%`, width: `${Math.max(hi - lo, 1)}%` }}
          />
        )}
        <div
          className={cn('absolute -top-[3px] h-[18px] w-0.5 rounded-full', bd.bgClass)}
          style={{ left: `calc(${clamp(score)}% - 1px)` }}
          data-testid="run-summary-eval-ci-marker"
        >
          <span className={cn('absolute -top-4 left-1/2 -translate-x-1/2 text-[11px] font-bold tabular-nums', bd.textClass)}>
            {score}
          </span>
        </div>
      </div>
      <div className="mt-2 flex justify-between text-[10px] tabular-nums text-text-tertiary">
        <span>0</span>
        <span>25</span>
        <span>50</span>
        <span>75</span>
        <span>100</span>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-text-tertiary">
        {hasRange
          ? `The point score is one read of a range — ${score} sits inside a plausible ${lo}–${hi}, not a precise verdict.`
          : 'The point score is one read — treat it as advisory, not a precise verdict.'}
      </p>
    </div>
  );
}
