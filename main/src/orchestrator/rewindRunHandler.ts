/**
 * rewindRunHandler — business logic for the monitor's REWIND power: revive a
 * PROGRAMMATIC run at an EARLIER step, purging the downstream step results and
 * aborting a live walk first when necessary.
 *
 * The run "monitor" is the supervisor chat agent for programmatic runs (the host
 * walks the step DAG). Rewind is one of its two new steering powers (the sibling
 * is LIVE-STEER — guidance injected into an already-running step, a different
 * lane): the operator asks the monitor to "go back to step X", and the run is
 * re-driven from step X through the SAME crash-safe resume machinery boot
 * recovery uses (setPendingResumeStep + setPendingCompletedSteps, read by the
 * next execute() to fast-forward to resumeFromStepId and skip already-completed
 * steps). PROGRAMMATIC-ONLY (execution_model === 'programmatic') — orchestrated
 * runs have their own re-drive escape hatches (reopen/resume/nudge) built on the
 * SDK --resume path, and programmatic runs are SDK-substrate by construction.
 *
 * `stepId` is REQUIRED — rewind is ALWAYS an explicit, operator-chosen target
 * (unlike retryRunHandler, which derives a default target from the last failed
 * row / current_step_id). There is deliberately no default-target resolution.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * This is the FIFTH sanctioned path that revives a run out of a state the state
 * machine calls terminal/resting via a guarded raw UPDATE (see
 * services/cyboflow/stateMachine.ts's ALLOWED_TRANSITIONS comment) — joining the
 * four retryRunHandler enumerates:
 *   1. runRecovery.recoverActiveStateOrphans (boot sweep).
 *   2. reopenRunHandler (SDK-only failed -> running via --resume).
 *   3. reviveQuickRunToRunning (quick-session sentinel repair).
 *   4. retryRunHandler (failed / resting awaiting_review -> starting at a step).
 *   5. rewindRunHandler (this file): running / live-gated awaiting_review /
 *      failed / paused -> starting at an EARLIER step, aborting the live walk
 *      first when one is holding the run.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Rewindable source states (deliberate DELTAS from retry, which refuses a live
 * walk):
 *   - 'running'          — a LIVE walk. We ABORT it first (see below), then
 *                          revive. This is the headline rewind case: pull a
 *                          mid-flight run back to an earlier step.
 *   - 'awaiting_review'  — resting OR parked LIVE at a human gate. Retry refuses
 *                          the live-gate case (it would race the gate's own
 *                          resolution); rewind ACCEPTS it because it aborts the
 *                          walk first, tearing that gate down before re-driving.
 *   - 'failed'           — a terminal run; rewind back into it and continue.
 *   - 'paused'           — a non-terminal park whose per-run queue is already
 *                          free (nothing to abort).
 *   - anything else (starting / completed / canceled / stuck / awaiting_input)
 *     → { noOp: 'not_rewindable' }.
 *
 * Target validation + the DIRECTIONAL guard: the target is validated against the
 * run's FROZEN WorkflowDefinition (resolveRunFrozenSpec → resolveWorkflowDefinition,
 * flattening every phase's steps — never the live workflows.spec_json; see
 * docs/CODE-PATTERNS.md) — an id not in the definition → { noOp: 'unknown_step' }. When
 * the run's current_step_id ALSO resolves to a flat index, the target must be
 * at-or-before it (targetIdx <= currentIdx), else { noOp: 'target_not_prior' }:
 * rewind means BACKWARD. `target === current` IS allowed — "restart the current
 * step live" (which retry refuses for a running walk, but rewind serves by
 * aborting first). When current_step_id is null or unresolvable, ANY valid
 * target is allowed (there is no anchor to be "prior" to).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Three-phase queue discipline (standalone-typecheck invariant — no imports from
 * 'electron', 'better-sqlite3', or main/src/services/*):
 * ───────────────────────────────────────────────────────────────────────────
 *   - PRE-FLIGHT + TARGET VALIDATION + LIVE-ABORT ARM run OUTSIDE the per-run
 *     queue. RunExecutor.execute() HOLDS runQueues[runId] for the ENTIRE
 *     programmatic walk (a run parked at a human gate holds it for hours/days),
 *     so the immediately-refusable cases (not_found / not_programmatic /
 *     not_rewindable / unknown_step / target_not_prior) MUST be decided from a
 *     pre-flight read WITHOUT enqueueing — an in-queue guard would wedge behind
 *     the live walk (and the monitor's serialized sendChain awaiting it). See
 *     retryRunHandler's DEADLOCK FIX header.
 *   - LIVE-ABORT (when a live executor holds the run) also runs OUTSIDE the
 *     queue, BEFORE Phase 1 is enqueued: requestProgrammaticCancel() fires the
 *     walk's AbortController SYNCHRONOUSLY, BEFORE ANY await (pauseRunHandler's
 *     ordering invariant — the walk signal must fire before the spawn abort
 *     unwinds the in-flight step, so that step reports 'aborted' not a clean
 *     'ok'), then `await stopLiveRun?.(runId)` (fail-soft) kills the spawn. An
 *     aborted programmatic walk writes NO status (runExecutor.ts's 'cancel path
 *     owns terminal'), so the rewinding caller's guarded UPDATE is the SOLE
 *     status writer. A task enqueued on the per-run queue AFTER the abort only
 *     runs once the aborted walk's execute() finally/teardownRun RELEASES the
 *     queue — that queue release IS the "wait for the walk to drain"
 *     synchronization primitive; there is no other teardown seam.
 *   - Phase 1 (belt-and-braces re-guards + the purge computation + ONE
 *     crash-atomic mutation transaction [lane reset + batch reopen + settled
 *     markers + step_results purge + the guarded revive UPDATE] + the
 *     pending-gate sweep) runs INSIDE the per-run PQueue (which the abort above
 *     has now released). The single transaction is deliberate: split writes left
 *     a crash window with purged rows but an un-flipped status, or a flipped
 *     status whose current_step_id still pointed at the OLD later step — boot
 *     recovery's resume pointer — silently skipping the requested target. The
 *     revive therefore also stamps current_step_id = target, making the durable
 *     triple (status='starting', current_step_id=target, purged rows) fully
 *     self-consistent for boot recovery; Phase 2's in-memory resume maps are
 *     only the fast path.
 *   - Phase 2 (setPendingResumeStep/setPendingCompletedSteps + emit +
 *     fire-and-forget re-drive) runs OUTSIDE the held queue — execute() re-enters
 *     the SAME run queue, so calling it from inside the guard would self-deadlock
 *     (no-recursive-enqueue rule, RunQueueRegistry.ts).
 *
 * DELIBERATE DEVIATION from retryRunHandler — NO cross-phase updated_at TOCTOU
 * assert. Retry snapshots updated_at in its pre-flight and asserts it in the
 * revive UPDATE to close a residual race. Rewind CANNOT: a LIVE walk legitimately
 * bumps updated_at (each step transition writes the row) between the pre-flight
 * read and Phase 1, so asserting the pre-flight snapshot would spuriously refuse
 * EVERY mid-flight rewind — exactly the case this handler exists to serve. The
 * in-queue re-guard (status still in the rewindable set — post-abort it is
 * UNCHANGED, because the canceled walk writes nothing) PLUS the revive UPDATE's
 * `status IN (...)` WHERE clause are the race guard instead (a concurrent
 * transition OUT of the set → 0 rows changed → { noOp: 'race' }).
 *
 * Purge rationale: the target-and-after step_results rows are STALE the moment we
 * rewind — deleteStepResults(runId, purgeIds) removes them so neither
 * boot-recovery's completedStepIds() nor a later resume skip set fast-forwards
 * past the very steps the rewind means to re-run (StepResultStore.deleteForSteps
 * docblock).
 *
 * FAN-OUT CARVE-OUT: a fully-INTEGRATED fan-out step in the purge slice is the
 * one exception to "purge everything at-and-after the target". The production
 * fan-out driver's resolveItems filters OUT lanes with status integrated/failed;
 * if a re-entered fanOut step resolves ZERO items the controller FALLS THROUGH
 * and runs it as a SINGLE agent turn (workflowController.ts ~381 'No items
 * resolved ⇒ fall through') — WRONG for a rewound-but-already-integrated fan-out.
 * So when the purge slice contains fanOut steps, Phase 1 FIRST consults
 * countRedispatchableLanes (a pure read — lanes that would dispatch after a
 * failed-lane reset, i.e. every non-integrated lane):
 *   - 0 re-dispatchable AND the TARGET ITSELF is a fanOut step → the rewind is
 *     REFUSED ({ noOp: 'fanout_settled' }): every lane is integrated, so nothing
 *     would re-run at the target — resuming there would only produce the
 *     degenerate zero-item single-agent turn. The operator should rewind to an
 *     earlier step (or add a task first). Refusing BEFORE any mutation keeps the
 *     refusal path side-effect free.
 *   - 0 re-dispatchable, fanOut steps strictly AFTER the target → those steps are
 *     EXCLUDED from the purge, keeping their 'done' rows, and threaded into the
 *     Phase-2 completed set so the re-driven walk SKIPS them via the
 *     completed-set instead of degrading to the zero-item single-agent turn. A
 *     kept step with NO 'done' row yet (walk aborted after the last lane
 *     integrated but before the outer result was recorded) gets a SETTLED MARKER
 *     row materialized inside the mutation transaction (recordStepResult) so the
 *     skip survives a crash; the Phase-2 set unions keptFanOutIds regardless.
 *   - >0 re-dispatchable (or the count seam absent) → resetFailedLanes(batchId)
 *     re-queues failed lanes and every fanOut step in the slice is purged and
 *     genuinely re-runs (re-dispatching the non-integrated lanes).
 *
 * RunDirectives survive a rewind: operator skip/steer directives (userSkipped /
 * steer, read mid-walk by the controller) live until the run's terminal
 * close-out and are DELIBERATELY not cleared here — a rewound region re-applies
 * any standing directives, and the operator can unskip / re-steer through the
 * monitor at any time. Only the run's pending GATE items (whose walk died) are
 * swept, since the re-driven walk re-mints its own gates.
 *
 * Fire-and-forget re-drive: like retryRunHandler / handoverRunHandler (and unlike
 * reopen/resume), the mutation does NOT await execute() — a programmatic walk can
 * park at a human gate for a long time. An execute() rejection is logged but never
 * surfaced; the executor's own failed-phase transition (or the next boot-recovery
 * sweep) owns the terminal outcome.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { RunQueueRegistry } from './RunQueueRegistry';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';
import { resolveRunFrozenSpec } from './runFrozenSpec';

// ---------------------------------------------------------------------------
// Collaborator interfaces
// ---------------------------------------------------------------------------

/**
 * Narrow slice of RunExecutor needed by the rewind handler. Injected (not the
 * concrete class) to preserve the standalone-typecheck invariant — the concrete
 * RunExecutor satisfies this shape structurally. Mirrors RetryRunExecutorLike +
 * the requestProgrammaticCancel seam pauseRunHandler/handoverRunHandler use.
 */
export interface RewindRunExecutorLike {
  setPendingResumeStep(runId: string, stepId: string): void;
  setPendingCompletedSteps(runId: string, stepIds: readonly string[]): void;
  /**
   * True while execute()/executeProgrammatic is between start and teardownRun for
   * this run — i.e. a live executor still holds the per-run queue (a live walk, or
   * a run parked at an open human gate). Gates whether the abort arm fires.
   */
  hasActiveExecution(runId: string): boolean;
  /**
   * Fire the run's programmatic DAG walk AbortController (the SAME signal
   * Cancel/Pause/Handover use). Settles in-memory gates and unwinds the walk
   * WITHOUT any status write (the writer decides the terminal state — here, the
   * revive UPDATE). MUST be called synchronously BEFORE any await so the walk
   * signal fires before the spawn abort unwinds the in-flight step. Returns true
   * when a walk was actually signaled.
   */
  requestProgrammaticCancel(runId: string): boolean;
  /** Re-drive the run — re-reads the row and fast-forwards to the resume step. */
  execute(runId: string): Promise<void>;
}

export interface RewindRunDeps {
  db: DatabaseLike;
  runQueues: RunQueueRegistry;
  runExecutor: RewindRunExecutorLike;
  /**
   * Kill a mid-step SDK spawn (the universal abort seam — SubstrateDispatchFacade
   * .abort). Mirrors pauseRunHandler's `stopLiveRun`. Only reached on the
   * live-executor path, AFTER requestProgrammaticCancel; fail-soft (a rejection /
   * no-live-process must not block the rewind). Optional — absent in older wiring
   * / tests degrades the abort to the walk-signal only.
   */
  stopLiveRun?: (runId: string) => Promise<void>;
  /**
   * Emit the project-wide run-status-changed signal AFTER the guarded revive
   * lands, so the rail / action-bar (activeRunsStore) sees the run go 'starting'.
   * Backed by the SAME emitRunStatus closure the lifecycleTransitions adapter
   * uses (index.ts).
   */
  emitRunStatusChanged: (runId: string, status: 'starting') => void;
  /**
   * step_results reader (StepResultStore-backed at the composition root). Feeds
   * the Phase-2 resume skip set — ONLY outcome === 'done' rows survive the purge,
   * so post-purge these are the strictly-earlier completed steps (plus any
   * kept-settled fan-out step).
   */
  listStepResults: (runId: string) => Array<{ stepId: string; outcome: string }>;
  /**
   * DELETE the purge slice's step_results rows (StepResultStore.deleteForSteps at
   * the composition root). The rewind purge primitive — see the header + the store
   * docblock. Returns the number of rows deleted.
   */
  deleteStepResults: (runId: string, stepIds: readonly string[]) => number;
  /**
   * Materialize a 'done' step_results row (StepResultStore.record at the
   * composition root). Used ONLY for the fan-out carve-out's SETTLED MARKER: a
   * kept-settled fan-out step may have NO persisted 'done' row (the rewind aborted
   * the walk after the last lane integrated but BEFORE the controller recorded the
   * outer step result) — without a durable row, a crash between the revive and the
   * re-drive would make boot recovery re-enter the settled fan-out with zero items
   * and degrade to the single-agent turn. Writing the row the aborted walk would
   * have written closes that window. Optional — absent, the in-memory completed
   * set still covers the non-crash path.
   */
  recordStepResult?: (r: {
    runId: string;
    stepId: string;
    phaseId?: string;
    outcome: 'done';
    attempts: number;
    summary?: string;
  }) => void;
  /**
   * Re-queue systemically/hard-failed sprint lanes so a re-driven fan-out step
   * re-dispatches them (SprintLaneStore.resetFailedLanes at the composition root).
   * Called once per rewind when the purge slice contains a fanOut step, the run
   * carries a batch_id, AND something is actually re-dispatchable (see
   * countRedispatchableLanes — a settled fan-out never resets, so a refused rewind
   * mutates nothing). Optional — a run/step with no fan-out never calls it.
   */
  resetFailedLanes?: (batchId: string) => number;
  /**
   * Count the batch's re-DISPATCHABLE lanes — the lanes a re-entered fan-out step
   * would resolve as items after a failed-lane reset, i.e. every lane NOT
   * 'integrated' (failed lanes count: resetFailedLanes re-queues them). A PURE
   * READ, consulted BEFORE resetFailedLanes so the fanout_settled refusal path
   * mutates nothing. 0 ⇒ every lane is integrated ⇒ refuse a fanOut TARGET
   * ('fanout_settled') / keep a strictly-after fanOut step settled (see header).
   * Optional — absent ⇒ no carve-out (fanOut steps are purged and re-run like any
   * other step, after resetFailedLanes).
   */
  countRedispatchableLanes?: (batchId: string) => number;
  /**
   * Un-terminal the run's sprint_batches row (SprintLaneStore.reopenBatch at the
   * composition root — revive ONLY from 'failed') so the rewind's completion
   * close-out can re-stamp it terminal. Optional — a run with no batch_id never
   * calls it; when the run DOES carry a batch_id it is called UNCONDITIONALLY
   * (the batch may sit terminal-'failed' regardless of which step is targeted),
   * exactly as retryRunHandler does.
   */
  reopenBatch?: (batchId: string) => number;
  /**
   * Dismiss the run's pending GATE review-items (gate:human-step:* /
   * gate:systemic-pause:* decision rows) whose walk just died, BEFORE the re-drive
   * — they would otherwise linger as orphan blocking rows; the re-driven walk
   * re-mints its gates. Production: HumanStepManager.clearPendingForRun. Fail-soft;
   * returns the count dismissed. Optional.
   */
  clearPendingGateItems?: (runId: string) => Promise<number>;
  /**
   * Settle + drop any pending approvals for the run after the revive (backed by
   * ApprovalRouter.clearPendingForRun). Optional. Mirrors pauseRunHandler.
   */
  clearPendingApprovalsForRun?: (runId: string) => void;
  /**
   * Settle any pending AskUserQuestion gate Promises for the run after the revive
   * (backed by QuestionRouter.clearPendingForRun). Optional.
   */
  clearPendingQuestionsForRun?: (runId: string) => void;
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Reasons a rewind is rejected without re-driving the run. */
export type RewindRunNoOpReason =
  | 'not_found'
  | 'not_programmatic'
  | 'not_rewindable'
  | 'unknown_step'
  | 'target_not_prior'
  | 'fanout_settled'
  | 'race';

export type RewindRunResult =
  | { delivered: true; stepId: string; abortedLiveWalk: boolean; fanOutKeptSettled: boolean }
  | { noOp: true; reason: RewindRunNoOpReason };

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface RewindRunRow {
  status: string;
  execution_model: string | null;
  current_step_id: string | null;
  batch_id: string | null;
}

/**
 * Discriminated guard outcome threaded out of the per-run PQueue task. `ok`
 * carries the carve-out results Phase 2 needs: whether any fan-out step was kept
 * settled, and the ids of those steps (so Phase 2 can add them BACK into the
 * completed set — a plain `index < targetIdx` filter would drop them because they
 * sit at/after the target).
 */
type GuardOutcome =
  | { ok: true; fanOutKeptSettled: boolean; keptFanOutIds: readonly string[] }
  | { ok: false; reason: RewindRunNoOpReason };

/** Statuses a programmatic run can be rewound from (see header for the rationale). */
const REWINDABLE_STATUSES = new Set<string>(['running', 'awaiting_review', 'failed', 'paused']);

const RUN_SELECT_SQL = `SELECT status, execution_model, current_step_id, batch_id
         FROM workflow_runs
        WHERE id = ?`;

/**
 * Resolve the run's FROZEN definition (resolveRunFrozenSpec — the spec the run
 * actually executes, per docs/CODE-PATTERNS.md "Per-run workflow definitions
 * resolve the FROZEN spec"). A live `workflows.spec_json` read here would
 * validate the target and compute the purge slice against the WRONG graph for a
 * variant run or a workflow edited mid-run — rejecting valid frozen steps,
 * accepting live-only targets the controller cannot resume at, and leaving stale
 * downstream step_results that boot recovery treats as completed.
 */
function resolveFrozenDefinition(db: DatabaseLike, runId: string) {
  const frozen = resolveRunFrozenSpec(db, runId);
  return frozen ? resolveWorkflowDefinition(frozen.workflowName, frozen.specJson) : null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Rewind a PROGRAMMATIC run to an EARLIER (or the current) step: abort any live
 * walk first, purge the downstream step results, revive the row to 'starting',
 * and re-drive from the target via the crash-safe resume machinery. See the
 * header docblock for the rewindable-state matrix, the directional guard, the
 * abort-first sole-writer contract, the fan-out carve-out, the no-TOCTOU
 * deviation, and the three-phase queue discipline.
 */
export async function rewindRunHandler(
  runId: string,
  stepId: string,
  deps: RewindRunDeps,
): Promise<RewindRunResult> {
  const {
    db,
    runQueues,
    runExecutor,
    stopLiveRun,
    emitRunStatusChanged,
    listStepResults,
    deleteStepResults,
    recordStepResult,
    resetFailedLanes,
    countRedispatchableLanes,
    reopenBatch,
    clearPendingGateItems,
    clearPendingApprovalsForRun,
    clearPendingQuestionsForRun,
    logger,
  } = deps;

  // ── 1. PRE-FLIGHT (OUTSIDE the per-run queue) ─────────────────────────────
  // A live walk HOLDS runQueues[runId] for its whole duration, so the
  // immediately-refusable cases MUST be decided here — enqueueing a guard behind a
  // live walk would wedge the mutation. See the header DEADLOCK FIX note.
  const preflightRow = db.prepare(RUN_SELECT_SQL).get(runId) as RewindRunRow | undefined;
  if (!preflightRow) {
    return { noOp: true, reason: 'not_found' };
  }
  if (preflightRow.execution_model !== 'programmatic') {
    return { noOp: true, reason: 'not_programmatic' };
  }
  if (!REWINDABLE_STATUSES.has(preflightRow.status)) {
    return { noOp: true, reason: 'not_rewindable' };
  }

  // ── 2. TARGET VALIDATION + directional guard ──────────────────────────────
  const definition = resolveFrozenDefinition(db, runId);
  const flat = definition ? definition.phases.flatMap((phase) => phase.steps) : [];
  const targetIdx = flat.findIndex((step) => step.id === stepId);
  if (targetIdx < 0) {
    return { noOp: true, reason: 'unknown_step' };
  }
  // Directional guard: rewind is BACKWARD. When current_step_id resolves to a flat
  // index, the target must be at-or-before it (target === current is allowed —
  // "restart the current step live"). When current_step_id is null/unresolvable
  // there is no anchor, so any valid target is allowed.
  const currentIdx = preflightRow.current_step_id
    ? flat.findIndex((step) => step.id === preflightRow.current_step_id)
    : -1;
  if (currentIdx >= 0 && targetIdx > currentIdx) {
    return { noOp: true, reason: 'target_not_prior' };
  }

  // ── 3. LIVE-ABORT ARM (OUTSIDE the queue, BEFORE enqueueing Phase 1) ───────
  // Only when a live executor actually holds the run — a resting failed/paused run
  // has nothing to abort and its queue is already free. requestProgrammaticCancel
  // FIRST, SYNCHRONOUSLY BEFORE ANY await (pauseRunHandler's ordering invariant),
  // so the walk AbortSignal fires before the spawn abort unwinds the in-flight step
  // and NO status is written (sole-writer rule — the revive UPDATE owns it); THEN
  // stopLiveRun kills the spawn (fail-soft). The walk must unwind and RELEASE the
  // per-run queue, or the Phase-1 task enqueued below would wedge behind it.
  let abortedLiveWalk = false;
  if (runExecutor.hasActiveExecution(runId)) {
    runExecutor.requestProgrammaticCancel(runId);
    if (stopLiveRun) {
      try {
        await stopLiveRun(runId);
      } catch (err) {
        logger?.warn('[rewindRun] stopLiveRun rejected — proceeding to rewind', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    abortedLiveWalk = true;
  }

  // ── 4. PHASE 1 (INSIDE the per-run PQueue — runs only after any aborted walk
  //      drains + releases the queue) ───────────────────────────────────────
  const rawGuardResult = await runQueues.getOrCreate(runId).add(async (): Promise<GuardOutcome> => {
    const row = db.prepare(RUN_SELECT_SQL).get(runId) as RewindRunRow | undefined;
    if (!row) {
      return { ok: false, reason: 'not_found' };
    }
    if (row.execution_model !== 'programmatic') {
      return { ok: false, reason: 'not_programmatic' };
    }
    // Post-abort the status is UNCHANGED — the canceled walk writes nothing — so it
    // is still one of the rewindable statuses; the revive UPDATE's status-IN WHERE
    // clause below must therefore include all four. NOTE (deliberate deviation from
    // retryRunHandler): NO cross-phase updated_at TOCTOU assert — a live walk
    // legitimately bumps updated_at (step transitions) between the pre-flight read
    // and this task, so asserting the pre-flight snapshot would spuriously refuse
    // every mid-flight rewind; this in-queue re-guard + the status-IN WHERE clause
    // are the race guard instead.
    if (!REWINDABLE_STATUSES.has(row.status)) {
      return { ok: false, reason: 'not_rewindable' };
    }

    // Re-derive flat/targetIdx defensively from the FROZEN spec (immutable per
    // run, but the re-read keeps Phase 1 self-contained). Phase ids ride along
    // for the settled-marker rows below.
    const def = resolveFrozenDefinition(db, runId);
    const flatEntries = def
      ? def.phases.flatMap((phase) => phase.steps.map((step) => ({ step, phaseId: phase.id })))
      : [];
    const flatSteps = flatEntries.map((entry) => entry.step);
    const tIdx = flatSteps.findIndex((step) => step.id === stepId);
    if (tIdx < 0) {
      return { ok: false, reason: 'unknown_step' };
    }

    // (a) Purge set = the target step and everything after it.
    const purgeSlice = flatSteps.slice(tIdx);
    let purgeIds = purgeSlice.map((step) => step.id);
    let fanOutKeptSettled = false;
    const keptFanOutIds: string[] = [];

    // FAN-OUT CARVE-OUT (see header). For a purge slice that contains any fanOut
    // step AND a batch_id: consult the PURE-READ re-dispatchable count FIRST (so
    // the refusal path below mutates nothing). When nothing would re-dispatch
    // (every lane integrated): a fanOut TARGET is refused outright — resuming
    // there would only produce the degenerate zero-item single-agent turn
    // (workflowController.ts ~381 fall-through) — while fanOut steps strictly
    // AFTER the target are kept settled so the re-driven walk SKIPS them via the
    // completed-set. When lanes ARE re-dispatchable (or the count seam is
    // absent), re-queue failed lanes and purge the fanOut steps like any others.
    let shouldResetLanes = false;
    if (row.batch_id) {
      const batchId = row.batch_id;
      const fanOutStepsInPurge = purgeSlice.filter((step) => step.fanOut);
      if (fanOutStepsInPurge.length > 0) {
        const redispatchable = countRedispatchableLanes ? countRedispatchableLanes(batchId) : undefined;
        if (redispatchable === 0) {
          if (flatSteps[tIdx].fanOut) {
            // The TARGET itself is a settled fan-out — nothing would re-run there.
            return { ok: false, reason: 'fanout_settled' };
          }
          for (const step of fanOutStepsInPurge) keptFanOutIds.push(step.id);
          const keptSet = new Set(keptFanOutIds);
          purgeIds = purgeIds.filter((id) => !keptSet.has(id));
          fanOutKeptSettled = true;
        } else if (resetFailedLanes) {
          // Deferred into the atomic mutation transaction below.
          shouldResetLanes = true;
        }
      }
    }

    // SETTLED MARKERS: a kept fan-out id may have NO persisted 'done' row (the
    // rewind aborted the walk after the last lane integrated but BEFORE the
    // controller recorded the outer step result). Without a durable row, both the
    // Phase-2 skip set (crash path: boot recovery re-derives it from step_results)
    // and any later resume would re-enter the settled fan-out with zero items —
    // the degenerate single-agent turn. Materialize the row the aborted walk
    // would have written, inside the transaction below.
    let settledMarkers: Array<{ stepId: string; phaseId: string }> = [];
    if (keptFanOutIds.length > 0) {
      const doneIds = new Set(
        listStepResults(runId)
          .filter((result) => result.outcome === 'done')
          .map((result) => result.stepId),
      );
      const keptSet = new Set(keptFanOutIds);
      settledMarkers = flatEntries
        .filter((entry) => keptSet.has(entry.step.id) && !doneIds.has(entry.step.id))
        .map((entry) => ({ stepId: entry.step.id, phaseId: entry.phaseId }));
    }

    // ── SINGLE CRASH-ATOMIC MUTATION TRANSACTION ────────────────────────────
    // Lane reset + batch reopen + settled markers + the step_results purge + the
    // guarded revive commit (or roll back) TOGETHER. Split across separate writes
    // (the original shape) a crash mid-window left partial state — most critically
    // purged rows + un-flipped status, or a flipped status with current_step_id
    // still pointing at the OLD later step, which boot recovery uses as the resume
    // pointer and would silently skip the requested target. The revive also stamps
    // current_step_id = target for exactly that reason: post-crash, the durable
    // (status='starting', current_step_id=target, purged rows) triple makes boot
    // recovery re-drive from the target with the correct skip set — the in-memory
    // pendingResumeStep map in Phase 2 is only the fast path.
    //
    // The guarded revive is the 5th sanctioned state-machine bypass (see header).
    // outcome=NULL matters: backfillTerminalOutcomes stamps outcome='failed' on
    // failed rows and every later outcome write is guarded outcome IS NULL. The
    // WHERE asserts the full rewindable status set (post-abort the row is still in
    // it) so a concurrent transition OUT of the set loses as a race — 0 rows
    // changed throws the sentinel, ROLLING BACK every mutation above it (the race
    // refusal path mutates nothing).
    const raceSentinel = new Error('rewind-revive-race');
    let requeuedLanes = 0;
    let reopenedBatch = 0;
    let deleted = 0;
    const applyRewind = db.transaction(() => {
      if (shouldResetLanes && resetFailedLanes && row.batch_id) {
        requeuedLanes = resetFailedLanes(row.batch_id);
      }
      // Un-terminal the batch UNCONDITIONALLY for any run carrying a batch_id
      // (the batch may sit terminal-'failed' regardless of which step is targeted —
      // same reasoning as retryRunHandler). Without this the completion close-out's
      // markBatchTerminal('completed') would be a guaranteed no-op.
      if (row.batch_id && reopenBatch) {
        reopenedBatch = reopenBatch(row.batch_id);
      }
      if (recordStepResult) {
        for (const marker of settledMarkers) {
          recordStepResult({
            runId,
            stepId: marker.stepId,
            phaseId: marker.phaseId,
            outcome: 'done',
            attempts: 1,
            summary: 'materialized at rewind: every sprint lane already integrated',
          });
        }
      }
      deleted = deleteStepResults(runId, purgeIds);
      const { changes } = db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'starting', current_step_id = ?, error_message = NULL,
                  ended_at = NULL, outcome = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status IN ('running', 'awaiting_review', 'failed', 'paused')`,
        )
        .run(stepId, runId) as { changes: number };
      if (changes === 0) throw raceSentinel;
    });
    try {
      applyRewind();
    } catch (err) {
      if (err === raceSentinel) {
        return { ok: false, reason: 'race' };
      }
      throw err;
    }
    if (fanOutKeptSettled) {
      logger?.info('[rewindRun] kept fully-integrated fan-out step(s) settled across rewind', {
        runId,
        batchId: row.batch_id,
        keptFanOutIds,
        materialized: settledMarkers.map((marker) => marker.stepId),
      });
    }
    if (shouldResetLanes) {
      logger?.info('[rewindRun] reset failed fan-out lanes for rewind', {
        runId,
        batchId: row.batch_id,
        requeued: requeuedLanes,
      });
    }
    if (row.batch_id && reopenBatch) {
      logger?.info('[rewindRun] reopened batch for rewind', {
        runId,
        batchId: row.batch_id,
        reopened: reopenedBatch,
      });
    }
    logger?.info('[rewindRun] purged downstream step results', {
      runId,
      stepId,
      purged: purgeIds,
      deleted,
    });

    // (e) Gate sweep (fail-soft, AFTER the revive lands). Dismiss the pending gate
    // items whose walk died — the re-driven walk re-mints its gates. RunDirectives
    // (operator skip/steer) DELIBERATELY survive — a rewound region re-applies any
    // standing directives (see header).
    if (clearPendingGateItems) {
      try {
        const dismissed = await clearPendingGateItems(runId);
        logger?.info('[rewindRun] cleared pending gate items on rewind', { runId, dismissed });
      } catch (err) {
        logger?.error('[rewindRun] clearPendingGateItems rejected (fail-soft)', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    clearPendingApprovalsForRun?.(runId);
    clearPendingQuestionsForRun?.(runId);

    return { ok: true, fanOutKeptSettled, keptFanOutIds };
  });

  // p-queue's add() widens the return with `| void` (a paused-queue artifact); our
  // task always returns a value.
  const guardResult = rawGuardResult as GuardOutcome;
  if (!guardResult.ok) {
    return { noOp: true, reason: guardResult.reason };
  }

  // ── 5. PHASE 2 (OUTSIDE the queue guard — execute() re-enters the same queue) ─
  emitRunStatusChanged(runId, 'starting');
  runExecutor.setPendingResumeStep(runId, stepId);

  // Completed skip set: the surviving 'done' rows. Post-purge these are the
  // strictly-earlier completed steps; defensively filter to flat index < targetIdx
  // (drop any stale downstream row the purge somehow missed) — BUT add back the
  // kept-settled fan-out step ids (they sit at/after the target on purpose, so the
  // `< targetIdx` filter would wrongly drop them and re-run the degenerate
  // zero-item step). The target itself is ALWAYS excluded — it must re-run.
  const keptSet = new Set(guardResult.keptFanOutIds);
  const completed = [
    ...new Set([
      ...listStepResults(runId)
        .filter((result) => result.outcome === 'done')
        .map((result) => result.stepId),
      // Belt-and-braces: the kept-settled fan-out ids join the skip set even when
      // no persisted 'done' row exists (the settled-marker seam is optional and
      // the walk may have been aborted before the outer result was recorded) —
      // otherwise the re-driven walk re-enters the settled fan-out with zero
      // items and degrades to the single-agent turn.
      ...guardResult.keptFanOutIds,
    ]),
  ].filter((id) => {
    if (id === stepId) return false;
    if (keptSet.has(id)) return true;
    const idx = flat.findIndex((step) => step.id === id);
    return idx >= 0 && idx < targetIdx;
  });
  if (completed.length > 0) {
    runExecutor.setPendingCompletedSteps(runId, completed);
  }

  // Fire-and-forget, mirroring retryRunHandler / boot recovery: the walk can park at
  // a human gate for a long time, so the mutation must not await it. An execute()
  // rejection is logged but never surfaced.
  void runQueues.getOrCreate(runId).add(async () => {
    try {
      await runExecutor.execute(runId);
    } catch (err) {
      logger?.error('[rewindRun] execute() rejected after rewind flip', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { delivered: true, stepId, abortedLiveWalk, fanOutKeptSettled: guardResult.fanOutKeptSettled };
}
