/**
 * schedulerHelpers — the `this`-free half of verificationScheduler.ts: the §5.4
 * drain-priority policy, the §5.2 seam-2 await primitives, and the row/summary
 * shapes they read. Every symbol here is a module-level constant, a plain type,
 * or a pure free function; nothing touches the scheduler instance or its
 * private state, which is exactly why it can live beside it.
 *
 * WHY IT IS ITS OWN FILE. GitHub issue #19: verificationScheduler.ts sits at a
 * frozen line cap in `__tests__/fileSizeRatchet.test.ts`, and the rule there is
 * EXTRACT, never bump the cap. This module is that extraction — the bodies are
 * verbatim, only their file moved (the three previously module-private symbols
 * are `export`ed so the scheduler can import them back; nothing else changed).
 *
 * verificationScheduler.ts RE-EXPORTS every symbol that was exported from it
 * before the move, so no import anywhere else in the repo changes. Import from
 * here only in new code.
 *
 * Standalone-typecheck invariant, same as the scheduler's: no 'electron', no
 * 'better-sqlite3', no 'fs', no concrete service from main/src/services/*.
 */
import type {
  RequestStatus,
  VerificationModality,
} from '../../../../shared/types/visualVerification';
import { REQUEST_STATUS } from '../../../../shared/types/visualVerification';
import type { VerifyRunbookModalityEntry } from '../../../../shared/types/verifyRunbook';

/**
 * §3.2 runbook state for one (project, modality). `'unproven-draft'` is
 * deliberately NOT a pass: the proposal's whole thesis is that a written config
 * nobody proved is what already failed once (§1, the `.cyboflow/verify.json`
 * era) — only `'proven'` opens the gate.
 */
export type RunbookStatus = 'proven' | 'unproven-draft' | 'absent';

/**
 * One PROVEN runbook revision, resolved at enqueue time by
 * {@link VerificationScheduler.resolveProvenRunbook} — the content to merge into
 * the composed task plus the two values that become the request row's PIN
 * (migration 096 `runbook_hash` / `runbook_local_version`).
 *
 * `hash` and `version` travel together on purpose: the hash content-addresses
 * the COMMITTED half (so the runner can resolve the exact revision from a
 * snapshot whose tree predates the file entirely) while the version is the
 * MACHINE-LOCAL record's CAS token (so a registration that swapped the record
 * underneath an in-flight request is diagnosable rather than silent).
 */
export interface ProvenRunbookRevision {
  hash: string;
  version: number;
  entry: VerifyRunbookModalityEntry;
}

/** The §3.4 circuit-breaker notice seam — see {@link VerificationSchedulerDeps.capabilityFinding}. */
export type CapabilityBreakerFindingFn = (args: {
  projectId: number;
  runId: string;
  modality: VerificationModality;
  /** The env-failure reason that tripped the breaker (the last terminal's evidence). */
  reason: string;
}) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/** A queued/leased/running verification_requests row, as the drain SELECT reads it. */
export interface VerificationRequestRow {
  id: string;
  run_id: string;
  project_id: number;
  status: string;
  verify_type: string;
  deliverable_json: string;
  chain_json: string | null;
  current_backend: string | null;
  attempt: number;
  /** ISO enqueue time — the anchor for the queued-age deadline (§5.6). */
  enqueued_at: string;
}

// ---------------------------------------------------------------------------
// Drain priority (§5.4 groundwork — "setup runs at lower priority")
// ---------------------------------------------------------------------------

/**
 * How long a `setup_proof` row may sit behind lane traffic before it is
 * PROMOTED to lane priority. Five minutes is the anti-starvation half of §5.4's
 * "setup proofs run at lower priority": without it a project with continuous
 * lane traffic could never prove a runbook — and it is precisely the projects
 * with the most lane traffic that most need one. Sized well under the 15-minute
 * `queuedAgeCeilingMs` so a promoted proof still has a real window to lease
 * before the age ceiling would terminalize it.
 */
export const SETUP_PROOF_PROMOTION_MS = 5 * 60 * 1000;

/** The two fields drain ordering keys on, plus the migration-095 setup-proof flag. */
export interface AgentDrainOrderRow {
  id: string;
  /** ISO enqueue time — the promotion clock's anchor. */
  enqueued_at: string;
  /**
   * Migration-095 `setup_proof`, read through the scheduler's DEFENSIVE
   * per-row query (fail-soft `false` on a pre-095 DB), never through the drain
   * SELECT — see {@link orderAgentDrainRows}.
   */
  setupProof: boolean;
}

/**
 * Order one drain pass's queued rows into the §5.4 priority classes. PURE (no
 * DB, no clock of its own — `nowMs` is passed in) so the policy is unit-testable
 * on its own, which is the whole reason it is a free function rather than a
 * private method.
 *
 * TWO classes, not a general priority queue:
 *   0. LANE requests (`setup_proof = 0`) — a live sprint lane is parked at
 *      awaiting-verify behind each one.
 *   1. SETUP-PROOF requests (`setup_proof = 1`) — nobody is blocked on them;
 *      §5.4 says they must not out-contend live lanes.
 * …with one exception: a setup proof older than {@link SETUP_PROOF_PROMOTION_MS}
 * is promoted INTO class 0 (anti-starvation).
 *
 * WHY NOT IN SQL. The drain SELECT is deliberately left untouched: it must keep
 * working against a pre-095 DB that has no `setup_proof` column at all, and an
 * `ORDER BY setup_proof` there would throw for every legacy row rather than
 * degrade. Ordering in JS off a fail-soft per-row read means a legacy row simply
 * reports `setupProof: false`, lands in class 0, and drains in the exact FIFO
 * order it always did.
 *
 * STABILITY. Within a class the caller's order is preserved verbatim (the
 * comparator falls back to the original index), so the SQL's
 * `ORDER BY enqueued_at, id` remains the FIFO source of truth and this helper
 * only ever moves rows BETWEEN classes.
 *
 * A starved setup proof is not silently lost either way: the §5.6 queued-age
 * ceiling still expires it through the normal delivery path, so the worst case
 * of a mis-sized pool is a visible 'skipped' with a concrete reason, never a row
 * that sits forever. Pool sizing itself stays decoupled from `SPRINT_BATCH_CAP`
 * (see {@link verifyAgentSlot}).
 */
export function orderAgentDrainRows<T extends AgentDrainOrderRow>(
  rows: readonly T[],
  nowMs: number,
): T[] {
  const priorityClass = (row: T): 0 | 1 => {
    if (!row.setupProof) return 0;
    const enqueuedMs = Date.parse(row.enqueued_at);
    // An unparseable enqueued_at cannot be aged, so it is NOT promoted — the same
    // conservative posture expireOverAgeQueued takes with the same column (a
    // clock/parse glitch must not silently reprioritize the backlog).
    if (!Number.isFinite(enqueuedMs)) return 1;
    return nowMs - enqueuedMs >= SETUP_PROOF_PROMOTION_MS ? 0 : 1;
  };
  return rows
    .map((row, index) => ({ row, index, cls: priorityClass(row) }))
    .sort((a, b) => (a.cls !== b.cls ? a.cls - b.cls : a.index - b.index))
    .map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// The synchronous proof primitive (§5.2 seam 2)
// ---------------------------------------------------------------------------

/**
 * The three statuses a request can hold while it is still ALIVE — the exact set
 * `markTerminal`'s guarded UPDATE keys on (`status IN ('queued','leased',
 * 'running')`). Everything else in {@link RequestStatus} is terminal by
 * construction, so deriving "terminal" from THIS set (rather than re-listing the
 * five terminal states) means a future status added to the union cannot be
 * silently treated as terminal by one site and non-terminal by the other.
 */
export const NON_TERMINAL_REQUEST_STATUSES: readonly RequestStatus[] = [
  'queued',
  'leased',
  'running',
] as const;

/** Whether a request has settled (passed/failed/low_confidence/skipped/timeout). */
export function isTerminalRequestStatus(status: RequestStatus): boolean {
  return !NON_TERMINAL_REQUEST_STATUSES.includes(status);
}

/** Narrow a raw `status` column value to the CHECK-constrained union. */
export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === 'string' && (REQUEST_STATUS as readonly string[]).includes(value);
}

/**
 * Pull `feedback` out of a persisted `verdict_json`. Fail-soft to `null` in every
 * degenerate case (column NULL on a skip/timeout, unparseable text, a verdict
 * without prose) — a caller blocking on a proof needs the STATUS to be right far
 * more than it needs the prose, and a parse hiccup must never turn a settled
 * verdict into an exception thrown at the awaiting flow.
 */
export function parseVerdictFeedback(verdictJson: unknown): string | null {
  if (typeof verdictJson !== 'string' || verdictJson.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(verdictJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const feedback = (parsed as { feedback?: unknown }).feedback;
    return typeof feedback === 'string' && feedback.length > 0 ? feedback : null;
  } catch {
    return null;
  }
}

/**
 * The snapshot {@link VerificationScheduler.awaitTerminal} resolves with — the
 * four things a caller blocking on a verdict actually needs to decide what to do
 * next, and nothing more (the screenshots artifact + the review-queue finding
 * already carry the rest through the ordinary delivery path).
 *
 * `failureClass` is the §3.1 attribution — `'env'` / `'deliverable'` /
 * `'ambiguous'` — and it is what makes a FAILED proof actionable: it tells the
 * setup flow whether to fix an isolation lever, fix the commands, or narrow the
 * task. Typed as a plain `string | null` rather than the
 * {@link VerificationFailureClass} union deliberately: it is read back off a DB
 * column, and a value written by a NEWER binary (or hand-edited) must surface
 * verbatim to the human rather than be narrowed away to `null` here.
 */
export interface AwaitTerminalOutcome {
  status: RequestStatus;
  errorMessage: string | null;
  failureClass: string | null;
  /** `verdict_json.feedback` — the judge's prose, when the outcome was judged. */
  feedback: string | null;
}

/**
 * One row of {@link VerificationScheduler.listRequestsForRun} — the COLD-READ
 * counterpart to {@link AwaitTerminalOutcome}. `awaitTerminal` answers "what
 * happened to the id I am holding"; this answers "what verifications does this
 * run have", which is the only question left once a context compaction has
 * taken the ids away.
 *
 * `screenshotFiles` is deliberately PER-REQUEST and nullable, not the run's
 * artifact file list: the `screenshots` artifact permanently UNIONS filenames
 * across every delivery on the run, so reporting it per row would attribute an
 * earlier turn's PNGs to this request. `null` means "this engine persisted no
 * exact per-request list" (the legacy capture path writes no `report_json`) —
 * distinct from `[]`, which means the agent ran and captured nothing.
 */
export interface VerificationRequestSummary {
  id: string;
  status: RequestStatus;
  verifyType: string | null;
  attempt: number;
  errorMessage: string | null;
  failureClass: string | null;
  feedback: string | null;
  enqueuedAt: string | null;
  endedAt: string | null;
  /**
   * The git sha the snapshot worktree was built at. Read together with
   * `dirtyWorktree` from the enqueue reply: a verdict certifies THIS sha, not
   * necessarily what the user is looking at.
   */
  snapshotSha: string | null;
  screenshotFiles: string[] | null;
}

/** How often {@link VerificationScheduler.awaitTerminal} re-reads the row. */
export const AWAIT_TERMINAL_POLL_INTERVAL_MS = 1000;

/**
 * The `errorMessage` an {@link VerificationScheduler.awaitTerminal} deadline
 * returns, alongside the request's CURRENT (still non-terminal) status. It is
 * deliberately NOT a `'timeout'` status: the request itself has not timed out —
 * it is still queued or running and will terminalize on its own schedule — only
 * this caller stopped waiting. Reporting it as a request timeout would make the
 * setup flow diagnose a deadline it never hit.
 */
export const AWAIT_TERMINAL_TIMEOUT_MESSAGE = 'await timeout';

/**
 * The `errorMessage` returned when the request id resolves to nothing at all
 * (never enqueued, or unreadable). Paired with a `'skipped'` status because that
 * is this scheduler's established "no verdict, and that is not a failure" state
 * — the caller must not read it as a pass, and must not loop back on it either.
 */
export const AWAIT_TERMINAL_NOT_FOUND_MESSAGE = 'request not found';
