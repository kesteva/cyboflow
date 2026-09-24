/**
 * verifyRequestModel — the shared read-model behind the Verify-Queue panel.
 *
 * The `verification_requests` row hands the renderer four TEXT columns holding
 * JSON (`deliverable_json` / `verdict_json` / `task_json` / `report_json`) plus a
 * lifecycle `status`. Both the queue CARD ({@link VerifyQueueView}) and the
 * detail dialog ({@link VerifyRequestDetailModal}) need the same derivations off
 * those columns — engine identity, the task summary, the one-line status — so
 * they live here once rather than being re-implemented (and drifting) per view.
 *
 * Every parser is DEFENSIVE: a malformed payload degrades to `null` / a neutral
 * fallback. A verify-queue panel must never throw or blank on one bad row.
 */
import {
  VERIFICATION_REPORT_OUTCOMES,
  type RequestStatus,
  type VerdictV1,
  type VerificationFailureClass,
  type VerificationFailureEvidence,
  type VerificationRequestInput,
  type VerificationTaskV1,
  type VerificationReportOutcome,
  type VerificationReportV1,
} from '../../../../shared/types/visualVerification';
import type { VerificationRequest } from '../../hooks/useVerificationRequests';

// ---------------------------------------------------------------------------
// Status palette + lifecycle partition
// ---------------------------------------------------------------------------

/**
 * Status badge palette — same compact rounded-full pill convention as
 * SprintLanesPanel's lane-status pills, extended across the full RequestStatus
 * lifecycle.
 */
export const STATUS_PILL_CLASS: Readonly<Record<RequestStatus, string>> = {
  queued: 'bg-bg-tertiary text-text-tertiary',
  leased: 'bg-interactive/15 text-interactive',
  running: 'bg-interactive/15 text-interactive',
  passed: 'bg-status-success/15 text-status-success',
  failed: 'bg-status-error/15 text-status-error',
  low_confidence: 'bg-status-warning/15 text-status-warning',
  skipped: 'bg-bg-tertiary text-text-tertiary',
  timeout: 'bg-status-error/15 text-status-error',
};

/** Terminal request statuses — a row past this point has a final report/verdict (or none, if it failed to produce one). */
export const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>([
  'passed',
  'failed',
  'low_confidence',
  'skipped',
  'timeout',
]);

/**
 * PENDING = not yet terminal, i.e. the live work queue (`queued` waiting for a
 * drain slot, `leased` holding resources, `running` under a backend/agent). The
 * partition is the complement of {@link TERMINAL_STATUSES} on purpose: adding a
 * future non-terminal status automatically lands it in the pending section
 * instead of silently disappearing into history.
 */
export function isPending(req: VerificationRequest): boolean {
  return !TERMINAL_STATUSES.has(req.status);
}

// ---------------------------------------------------------------------------
// JSON-column parsers
// ---------------------------------------------------------------------------

/** Parse the serialized VerificationRequestInput; null on any parse failure. */
export function parseDeliverable(json: string): VerificationRequestInput | null {
  try {
    return JSON.parse(json) as VerificationRequestInput;
  } catch {
    return null;
  }
}

/** Parse the serialized VerdictV1; null when absent or malformed. */
export function parseVerdict(json: string | null): VerdictV1 | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as VerdictV1;
  } catch {
    return null;
  }
}

/** Parse the serialized composed VerificationTaskV1 (migration 078 `task_json`); null when absent/malformed. */
export function parseTask(json: string | null): VerificationTaskV1 | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as { summary?: unknown };
    return typeof parsed.summary === 'string' ? (parsed as VerificationTaskV1) : null;
  } catch {
    return null;
  }
}

/**
 * Parse the serialized `VerificationReportV1` (migration 078 `report_json`).
 * Only the shape the detail dialog actually walks is asserted (a valid
 * `outcome` plus array `behaviors` / `screenshots`); anything else degrades to
 * null so a half-written report can never crash the dialog.
 */
export function parseReport(json: string | null): VerificationReportV1 | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as {
      outcome?: unknown;
      behaviors?: unknown;
      screenshots?: unknown;
    };
    if (!isReportOutcome(parsed.outcome)) return null;
    if (!Array.isArray(parsed.behaviors) || !Array.isArray(parsed.screenshots)) return null;
    return parsed as VerificationReportV1;
  } catch {
    return null;
  }
}

/**
 * True for a valid `VerificationReportV1['outcome']` member — read off the
 * shared {@link VERIFICATION_REPORT_OUTCOMES} list, so a report whose outcome
 * the harness accepts can never degrade to "no report" here.
 */
function isReportOutcome(value: unknown): value is VerificationReportOutcome {
  return (VERIFICATION_REPORT_OUTCOMES as readonly unknown[]).includes(value);
}

/**
 * Human copy for each report outcome — the Verify-Queue card's "report
 * outcome: …" line. A `Record` over the shared union, so a new outcome is a
 * compile error here until it has a label rather than a raw snake_case token.
 */
export const REPORT_OUTCOME_LABEL: Readonly<Record<VerificationReportOutcome, string>> = {
  pass: 'pass',
  fail: 'fail',
  build_failed: 'build failed',
  launch_failed: 'launch failed',
  unverifiable: 'unverifiable',
  wrong_environment: 'wrong environment',
};

/**
 * Just the `outcome` member of a serialized `VerificationReportV1` — the CARD
 * shows the report OUTCOME only, not the whole report (behaviors/evidence are
 * the detail dialog's job, and also live on the screenshots artifact, §5.9).
 */
export function parseReportOutcome(json: string | null): VerificationReportOutcome | null {
  if (json === null) return null;
  try {
    const outcome = (JSON.parse(json) as { outcome?: unknown }).outcome;
    return isReportOutcome(outcome) ? outcome : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Derived row copy
// ---------------------------------------------------------------------------

/**
 * Engine identity: the CHEAPEST correct signal already on the row is
 * `task_json` presence — the dual-write contract (§5.2) populates it for
 * every request enqueued via the composed-task path (the agent engine), and
 * leaves it NULL for every legacy capture/judge request. The alternative
 * (joining the run's stamped `verify_chain`) needs a second read this
 * observability panel has no reason to pay for.
 */
export function isAgentEngineRow(req: VerificationRequest): boolean {
  return req.task_json !== null;
}

/** The task summary line: the composed task's `summary` (agent rows), else the legacy `deliverable_json.intent`. */
export function taskSummary(req: VerificationRequest): string {
  const task = parseTask(req.task_json);
  if (task !== null) return task.summary.trim();
  const deliverable = parseDeliverable(req.deliverable_json);
  return deliverable?.intent?.trim() ?? '';
}

/** Agent-appropriate lifecycle copy for a non-terminal agent-engine row. */
function agentLifecycleSummary(req: VerificationRequest): string {
  if (req.status === 'queued' || req.status === 'leased') return 'Awaiting the verification agent';
  if (req.status === 'running') return 'Agent building + driving the deliverable';
  return 'No verdict yet';
}

/** Legacy capture/judge lifecycle copy for a non-terminal legacy-engine row. */
function legacyLifecycleSummary(req: VerificationRequest): string {
  if (req.status === 'queued') return 'Awaiting a free capture slot';
  if (req.status === 'leased' || req.status === 'running') return 'Capturing / judging…';
  if (req.status === 'skipped') return 'No backend could satisfy this type';
  return 'No verdict yet';
}

/**
 * A one-line status summary for a row: the judged VerdictV1 (legacy terminal
 * rows), else the report's `outcome` (agent terminal rows), else the last
 * runtime error, else lifecycle-derived copy branched on engine identity.
 */
export function statusSummary(req: VerificationRequest, isAgent: boolean): string {
  const verdict = parseVerdict(req.verdict_json);
  if (verdict !== null) {
    const pct = Math.round(verdict.confidence * 100);
    const feedback = verdict.feedback.trim();
    const head = `${verdict.status} · ${pct}%`;
    return feedback.length > 0 ? `${head} — ${feedback}` : head;
  }
  if (TERMINAL_STATUSES.has(req.status)) {
    const outcome = parseReportOutcome(req.report_json);
    if (outcome !== null) return `report outcome: ${REPORT_OUTCOME_LABEL[outcome]}`;
  }
  if (req.error_message !== null && req.error_message.trim().length > 0) {
    return req.error_message;
  }
  return isAgent ? agentLifecycleSummary(req) : legacyLifecycleSummary(req);
}

/**
 * The label for the origin-session pill. Prefers the joined `sessions.name`;
 * falls back to the session id, then to the run id, so the pill is never blank
 * (a request always has a run, even when its session row is gone).
 */
export function sessionLabel(req: VerificationRequest): string {
  const name = req.session_name?.trim();
  if (name !== undefined && name.length > 0) return name;
  const id = req.session_id?.trim();
  if (id !== undefined && id.length > 0) return id;
  return req.run_id;
}

// ---------------------------------------------------------------------------
// Failure-class chip + budget line
// (docs/proposals/verification-setup-flow.md §3.1 "Attribution split" / §3.6
// "surface budget state in the Verify Queue"; migration 095.)
// ---------------------------------------------------------------------------

/**
 * Muted chip styling for the failure-class label — deliberately QUIET, unlike
 * {@link STATUS_PILL_CLASS} / `RESULT_PILL_CLASS`'s severity coloring. The
 * class is informational provenance ("why did this land here"), not a
 * lifecycle state the user needs to triage at a glance; the status pill next
 * to it already carries the urgency.
 */
export const FAILURE_CLASS_CHIP_CLASS = 'bg-bg-tertiary text-text-tertiary';

/**
 * Short label + one-line explanation per {@link VerificationFailureClass},
 * for the chip's visible text and its `title` tooltip. Mirrors the three-way
 * doc on the shared type (§3.1) — never invents copy the classifier's own
 * contract doesn't already state.
 */
export const FAILURE_CLASS_COPY: Readonly<Record<VerificationFailureClass, { label: string; title: string }>> = {
  env: {
    label: 'env',
    title: 'Harness-proven environment failure — not charged to the lane’s retry budget.',
  },
  deliverable: {
    label: 'deliverable',
    title: 'A judged failure attributable to the code under test.',
  },
  ambiguous: {
    label: 'ambiguous',
    title: 'No harness-derived provenance either way — treated as blocking, same as an undifferentiated failure.',
  },
};

/**
 * True when a row is BOTH terminal AND carries a classified failure — the
 * exact condition the chip renders under (§3.1: `failureClass` is stamped
 * only on a terminal failure, but a defensive terminal-status check keeps the
 * chip from ever appearing on a still-live row even if a future writer bug
 * stamped one early).
 */
export function hasFailureClassChip(req: VerificationRequest): boolean {
  return TERMINAL_STATUSES.has(req.status) && req.failureClass !== undefined;
}

/**
 * One {@link VerificationFailureEvidence} entry formatted for the bounded,
 * monospace evidence list in the detail dialog: `source (check): detail`,
 * omitting the parenthesized check id when the entry did not carry one.
 */
export function formatFailureEvidence(entry: VerificationFailureEvidence): string {
  const check = entry.check !== undefined && entry.check.trim().length > 0 ? ` (${entry.check})` : '';
  return `${entry.source}${check}: ${entry.detail}`;
}

/**
 * The compact budget-line copy for the Verify-Queue header: "verify budget:
 * used/total". Callers are expected to skip rendering the line entirely when
 * `budgetCalls` is `null` (unlimited, §3.6) — this formatter assumes a
 * resolved, non-null total and does not special-case unlimited itself.
 */
export function budgetLineText(usedCalls: number, budgetCalls: number): string {
  return `verify budget: ${usedCalls}/${budgetCalls}`;
}
