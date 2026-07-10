/**
 * handoverRunHandler — business logic for handing a PROGRAMMATIC run over to the
 * ORCHESTRATED plane mid-run.
 *
 * The monitor (the run's chat brain) requests this when the user's request
 * exceeds what the host-driven DAG walk can do — e.g. the user wants the run to
 * take a fundamentally different path than the frozen workflow steps allow.
 * Rather than fail or fight the programmatic controller, the run is CONVERTED:
 * the step controller is detached and a fresh orchestrated agent conversation
 * takes over the remaining work, driven by a handover brief.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ⚠ execution_model CARVE-OUT — the FIRST and ONLY sanctioned UPDATE of
 *   workflow_runs.execution_model.
 * ───────────────────────────────────────────────────────────────────────────
 * execution_model is otherwise IMMUTABLE: it is stamped ONCE at createRun
 * (migration 032's contract — the sibling immutable stamp to `substrate`) and
 * NOTHING else in the codebase UPDATEs it. This handler is the single deliberate
 * exception. The carve-out is:
 *   - ONE-WAY ONLY: programmatic -> orchestrated. There is no orchestrated ->
 *     programmatic path anywhere.
 *   - GUARDED so it can NEVER flip the wrong direction: the revive UPDATE's WHERE
 *     asserts `execution_model = 'programmatic'`, so an already-orchestrated run
 *     matches 0 rows and is refused as a race. The column can only ever move
 *     programmatic -> orchestrated, and only from a switchable status.
 * If you are auditing "who writes execution_model", this is the answer: here, and
 * only here.
 *
 * Switchable source states (execution_model === 'programmatic'):
 *   - 'failed'           — a run that died terminal; take it over and continue.
 *   - 'awaiting_review'  — a run resting at (or parked live at) a human gate.
 *   - 'running'          — a LIVE walk. This is the "take over a stuck/misbehaving
 *                          run" case: the walk is aborted first (see below), then
 *                          converted.
 * Anything else is refused:
 *   - 'completed' / 'canceled' — intentional terminal ends → { noOp: 'not_switchable' }.
 *   - 'starting'               — mid-revive/boot, no stable step state to hand over
 *                                → { noOp: 'not_switchable' }.
 *   - queued / awaiting_input / stuck / paused → likewise not_switchable.
 *
 * The seeded conversation is FRESH, not resumed: programmatic runs have no
 * claude_session_id (their per-step SDK sessions are ephemeral), so
 * setPendingNudge + execute() forks a brand-new orchestrated conversation with
 * the handover brief as its first user turn — execute() re-reads the row (now
 * execution_model='orchestrated') and takes the orchestrated fork.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Queue discipline (mirrors retryRunHandler / pauseRunHandler; standalone-
 * typecheck invariant — no imports from 'electron', 'better-sqlite3', or
 * main/src/services/*):
 * ───────────────────────────────────────────────────────────────────────────
 *   - PRE-FLIGHT read runs OUTSIDE the per-run queue. RunExecutor.execute() HOLDS
 *     runQueues[runId] for the ENTIRE programmatic walk (a run parked at a human
 *     gate holds it for hours/days), so the immediately-refusable cases
 *     (not_found / not_programmatic / not_switchable) MUST be decided from a
 *     pre-flight read WITHOUT enqueueing — an in-queue guard would wedge behind
 *     the live walk.
 *   - ABORT (when a live executor holds the run) runs OUTSIDE the queue too, and
 *     BEFORE Phase 1 is enqueued: requestProgrammaticCancel() unwinds the walk
 *     (settling in-memory gates, NO status write — the pause precedent's "sole
 *     writer" rule) and stopLiveRun() kills the in-flight step spawn. Only once
 *     the walk unwinds and RELEASES the per-run queue can the enqueued Phase-1
 *     task run — otherwise it would wedge behind the still-held queue.
 *   - Phase 1 (belt-and-braces re-guards + the guarded execution_model/status flip
 *     + the pending-gate sweep) runs INSIDE the per-run PQueue.
 *   - Phase 2 (compose brief + setPendingNudge + emit + fire-and-forget execute)
 *     runs OUTSIDE the queue guard — execute() re-enters the SAME run queue, so
 *     calling it from inside the guard would self-deadlock (no-recursive-enqueue
 *     rule, RunQueueRegistry.ts).
 *
 * WHY the flip guards on model+status and NOT on an updated_at snapshot (unlike
 * retryRunHandler): the abort UNWIND legitimately bumps updated_at via the
 * interrupted step's own result write (step reporting), so an `updated_at = ?`
 * assertion would spuriously fail the flip as a race on exactly the live-walk
 * path this handler exists to serve. The `execution_model='programmatic' AND
 * status IN (...)` guard is sufficient: the only thing that could invalidate the
 * handover between pre-flight and flip is a concurrent transition OUT of the
 * switchable set (→ 0 rows → race), which the status guard already catches.
 *
 * Fire-and-forget re-drive: like retryRunHandler (and unlike reopen/resume), the
 * mutation does NOT await execute() — a fresh orchestrated conversation can run
 * for a long time. An execute() rejection is logged but never surfaces; the
 * executor's own failed-phase transition (or the next boot-recovery sweep) owns
 * the terminal outcome.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { RunQueueRegistry } from './RunQueueRegistry';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Collaborator interfaces
// ---------------------------------------------------------------------------

/**
 * Narrow slice of RunExecutor needed by the handover handler. Injected (not the
 * concrete class) to preserve the standalone-typecheck invariant — the concrete
 * RunExecutor satisfies this shape structurally. setPendingNudge is the SAME map
 * nudge/reopen use, so the executor forks the seeded orchestrated conversation
 * exactly like a nudge (but FRESH, since a programmatic run has no
 * claude_session_id to --resume).
 */
export interface HandoverRunExecutorLike {
  /**
   * True while execute()/executeProgrammatic is between start and teardownRun for
   * this run — i.e. a live executor still holds the per-run queue (a live walk, or
   * a run parked at an open human gate). Gates whether the abort seam fires.
   */
  hasActiveExecution(runId: string): boolean;
  /**
   * Signal the run's programmatic DAG walk to abort (the WorkflowController
   * AbortSignal — the SAME signal Cancel/Pause use). Settles in-memory gates and
   * unwinds the walk WITHOUT any status write (the writer decides the terminal
   * state). MUST be called BEFORE stopLiveRun so the interrupted step observes an
   * aborted signal. Returns true when a walk was actually signaled.
   */
  requestProgrammaticCancel(runId: string): boolean;
  /** Stash the handover brief as the run's next (first, for a fresh convo) user turn. */
  setPendingNudge(runId: string, text: string): void;
  /** Re-drive the run — re-reads the row and forks the orchestrated conversation. */
  execute(runId: string): Promise<void>;
}

export interface HandoverRunDeps {
  db: DatabaseLike;
  runQueues: RunQueueRegistry;
  runExecutor: HandoverRunExecutorLike;
  /**
   * Emit the project-wide run-status-changed signal AFTER the guarded flip
   * succeeds, so the rail / action-bar (activeRunsStore) sees the run go
   * 'starting'. Backed by the SAME emitRunStatus closure the lifecycleTransitions
   * adapter uses (index.ts).
   */
  emitRunStatusChanged: (runId: string, status: 'starting') => void;
  /**
   * Dismiss the run's pending gate review-items (gate:human-step:* /
   * gate:systemic-pause:* decision rows) BEFORE the fresh conversation seeds, so
   * the review queue holds no orphan gates from the detached walk. Production:
   * HumanStepManager.clearPendingForRun. Fail-soft; returns the count dismissed.
   */
  clearPendingGateItems: (runId: string) => Promise<number>;
  /**
   * Kill a mid-step SDK spawn (the universal abort seam — SubstrateDispatchFacade
   * .abort). Mirrors pauseRunHandler's `stopLiveRun`. Only reached on the
   * live-executor path, AFTER requestProgrammaticCancel; fail-soft (a rejection /
   * no-live-process must not block the flip). Optional — absent in older wiring /
   * tests degrades the abort to the walk-signal only.
   */
  stopLiveRun?: (runId: string) => Promise<void>;
  /**
   * Tear down the run's on-demand MONITOR after the flip: dispose its per-run inject
   * plumbing (RunExecutor.disposeMonitorResources) AND unregister its MonitorRegistry
   * entry. Enforces the invariant "orchestrated runs have no monitor" on the LIVE
   * registry — the rehydrator already refuses to revive an orchestrated run's monitor
   * (monitorRehydration.ts), but a run that started programmatic registered a live
   * monitor session that would otherwise outlive the handover, keeping the chat
   * composer wired to the (now-inappropriate, read-only) monitor instead of the fresh
   * orchestrated agent that just took over the chat. Called AFTER the flip succeeds
   * and BEFORE emitRunStatusChanged, so the frontend's status-keyed monitor.isActive
   * re-probe observes the torn-down session and reverts to the orchestrated send path.
   * Fail-soft (a throw must not un-do the flip). Production:
   * runExecutor.disposeMonitorResources + MonitorRegistry.unregister. Optional —
   * absent in older wiring / tests is a no-op.
   */
  disposeMonitor?: (runId: string) => void;
  /**
   * Read a workflow's prompt body by WORKFLOW ID (production:
   * WorkflowRegistry.getById -> readWorkflowPromptForRow at the composition root).
   * Keyed by id, not name — workflow names are not unique across projects. Used to
   * fold the full workflow instructions into the handover brief. null when the
   * prompt is unavailable (custom flow / missing file) — the brief then notes it.
   */
  readWorkflowPrompt: (workflowId: string) => string | null;
  /**
   * step_results reader (StepResultStore-backed at the composition root). Feeds the
   * brief's "Completed so far" + "Remaining steps" sections.
   */
  listStepResults: (
    runId: string,
  ) => Array<{ stepId: string; outcome: string; summary?: string | null; error?: string | null }>;
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Reasons a handover is rejected without converting the run. */
export type HandoverNoOpReason = 'not_found' | 'not_programmatic' | 'not_switchable' | 'race';

export type HandoverRunResult = { delivered: true } | { noOp: true; reason: HandoverNoOpReason };

// ---------------------------------------------------------------------------
// Internal row type
// ---------------------------------------------------------------------------

interface HandoverRunRow {
  status: string;
  execution_model: string | null;
  current_step_id: string | null;
  workflow_id: string;
  workflow_name: string;
  spec_json: string | null;
}

/** Discriminated guard outcome threaded out of the per-run PQueue task. */
type GuardOutcome = { ok: true } | { ok: false; reason: HandoverNoOpReason };

/**
 * Statuses from which a programmatic run can be handed over. 'running' is included
 * deliberately — it is the "take over a stuck/misbehaving live run" case (the walk
 * is aborted first). Everything not here (completed/canceled/starting/queued/
 * awaiting_input/stuck/paused) is not_switchable.
 */
const SWITCHABLE_STATUSES = new Set<string>(['failed', 'awaiting_review', 'running']);

const RUN_SELECT_SQL = `SELECT r.status AS status, r.execution_model AS execution_model,
              r.current_step_id AS current_step_id, r.workflow_id AS workflow_id,
              w.name AS workflow_name, w.spec_json AS spec_json
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
        WHERE r.id = ?`;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Convert a PROGRAMMATIC run to the ORCHESTRATED plane mid-run and seed a fresh
 * orchestrated conversation with a handover brief. See the header docblock for the
 * execution_model carve-out, the switchable-state matrix, the abort ordering, and
 * the queue discipline.
 */
export async function handoverRunHandler(
  runId: string,
  reason: string,
  deps: HandoverRunDeps,
): Promise<HandoverRunResult> {
  const {
    db,
    runQueues,
    runExecutor,
    emitRunStatusChanged,
    clearPendingGateItems,
    stopLiveRun,
    disposeMonitor,
    readWorkflowPrompt,
    listStepResults,
    logger,
  } = deps;

  // Pre-flight (OUTSIDE the per-run queue). A programmatic walk HOLDS
  // runQueues[runId] for its entire duration, so the immediately-refusable cases
  // MUST be decided here — enqueueing a guard behind a live walk would wedge the
  // mutation (and the monitor's serialized sendChain awaiting it). See header.
  const preflightRow = db.prepare(RUN_SELECT_SQL).get(runId) as HandoverRunRow | undefined;
  if (!preflightRow) {
    return { noOp: true, reason: 'not_found' };
  }
  if (preflightRow.execution_model !== 'programmatic') {
    return { noOp: true, reason: 'not_programmatic' };
  }
  if (!SWITCHABLE_STATUSES.has(preflightRow.status)) {
    return { noOp: true, reason: 'not_switchable' };
  }

  // Capture the immutable-for-the-run workflow identity + spec for Phase-2 brief
  // composition (they cannot change mid-run).
  const workflowId = preflightRow.workflow_id;
  const workflowName = preflightRow.workflow_name;
  const specJson = preflightRow.spec_json;

  // ABORT the live walk (OUTSIDE the queue, BEFORE enqueueing Phase 1). Only when
  // a live executor actually holds the run — a resting failed/awaiting_review run
  // has nothing to abort and its queue is already free. requestProgrammaticCancel
  // FIRST (synchronously, no await) so the walk AbortSignal fires before the spawn
  // abort unwinds the in-flight step and NO status is written (sole-writer rule);
  // THEN stopLiveRun kills the spawn (fail-soft). Ordering matters: the walk must
  // unwind and RELEASE the per-run queue, or the Phase-1 task enqueued below would
  // wedge behind the still-held queue.
  if (runExecutor.hasActiveExecution(runId)) {
    runExecutor.requestProgrammaticCancel(runId);
    if (stopLiveRun) {
      try {
        await stopLiveRun(runId);
      } catch (err) {
        logger?.error('[handoverRun] stopLiveRun rejected — proceeding to flip', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Phase 1: belt-and-braces re-guards + the guarded execution_model/status flip +
  // the pending-gate sweep, serialized inside the per-run PQueue (which the walk
  // abort above has now released).
  const rawGuardResult = await runQueues.getOrCreate(runId).add(async (): Promise<GuardOutcome> => {
    const row = db.prepare(RUN_SELECT_SQL).get(runId) as HandoverRunRow | undefined;
    if (!row) {
      return { ok: false, reason: 'not_found' };
    }
    if (row.execution_model !== 'programmatic') {
      return { ok: false, reason: 'not_programmatic' };
    }
    if (!SWITCHABLE_STATUSES.has(row.status)) {
      return { ok: false, reason: 'not_switchable' };
    }

    // The guarded flip — the SANCTIONED, one-way, programmatic->orchestrated
    // execution_model UPDATE (see the header carve-out block). WHERE asserts
    // execution_model='programmatic' (so it can NEVER flip the other direction)
    // AND a switchable status (so a concurrent transition out of the set loses as
    // a race). Deliberately does NOT assert an updated_at snapshot — the abort
    // unwind legitimately bumps updated_at via step reporting (header rationale).
    // Clears the terminal stamps (error_message/ended_at/outcome) so the fresh
    // orchestrated conversation starts clean.
    const flip = db.transaction(() => {
      return db
        .prepare(
          `UPDATE workflow_runs
              SET execution_model = 'orchestrated', status = 'starting',
                  error_message = NULL, ended_at = NULL, outcome = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND execution_model = 'programmatic'
              AND status IN ('failed', 'awaiting_review', 'running')`,
        )
        .run(runId) as { changes: number };
    });
    const { changes } = flip();
    if (changes === 0) {
      return { ok: false, reason: 'race' };
    }

    // Dismiss any pending gate review-items from the now-detached walk so the queue
    // holds no orphan gates. Fail-soft: a rejection here must not un-do the flip.
    try {
      const dismissed = await clearPendingGateItems(runId);
      logger?.info('[handoverRun] cleared pending gate items on handover', { runId, dismissed });
    } catch (err) {
      logger?.error('[handoverRun] clearPendingGateItems rejected (fail-soft)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { ok: true };
  });

  // p-queue's add() widens the return with `| void` (a paused-queue artifact); our
  // task always returns a value.
  const guardResult = rawGuardResult as GuardOutcome;
  if (!guardResult.ok) {
    return { noOp: true, reason: guardResult.reason };
  }

  // Phase 2: compose the brief + seed the fresh conversation + re-drive, OUTSIDE
  // the queue guard (execute() re-enters the same run queue — see header note).
  const definition = resolveWorkflowDefinition(workflowName, specJson);
  const steps = definition
    ? definition.phases.flatMap((phase) => phase.steps).map((step) => ({ id: step.id, name: step.name }))
    : [];
  const prompt = composeHandoverPrompt({
    runId,
    workflowName,
    promptBody: readWorkflowPrompt(workflowId),
    steps,
    stepResults: listStepResults(runId),
    reason,
  });

  runExecutor.setPendingNudge(runId, prompt);

  // Tear down the run's on-demand monitor now that it is orchestrated: the fresh
  // orchestrated agent owns the chat from here, so the composer must stop routing
  // human turns to the (read-only) monitor. Done BEFORE emitRunStatusChanged so the
  // frontend's status-keyed monitor.isActive re-probe sees the session gone and
  // reverts to the orchestrated send path. Fail-soft — a throw must not un-do the
  // flip or block the re-drive.
  if (disposeMonitor) {
    try {
      disposeMonitor(runId);
    } catch (err) {
      logger?.error('[handoverRun] disposeMonitor threw (fail-soft)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  emitRunStatusChanged(runId, 'starting');

  // Fire-and-forget, mirroring retryRunHandler / boot recovery: a fresh
  // orchestrated conversation can run for a long time, so the mutation must not
  // await it. An execute() rejection is logged but never surfaced.
  void runQueues.getOrCreate(runId).add(async () => {
    try {
      await runExecutor.execute(runId);
    } catch (err) {
      logger?.error('[handoverRun] execute() rejected after handover flip', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { delivered: true };
}

// ---------------------------------------------------------------------------
// composeHandoverPrompt (pure, exported, unit-tested separately)
// ---------------------------------------------------------------------------

/** Input to the pure handover-brief composer. */
export interface HandoverPromptInput {
  runId: string;
  workflowName: string;
  /** The workflow's full prompt body, or null when unavailable (custom flow / missing file). */
  promptBody: string | null;
  /** Definition steps in order, flattened from resolveWorkflowDefinition(name, spec_json). */
  steps: Array<{ id: string; name: string }>;
  /** step_results rows recorded so far (execution order). */
  stepResults: Array<{ stepId: string; outcome: string; summary?: string | null; error?: string | null }>;
  /** The user's request that triggered the handover, verbatim. */
  reason: string;
}

/** Per-line cap for the "Completed so far" digest (chars). */
const MAX_COMPLETED_LINE = 200;

/** Truncate a single digest line to ~MAX chars, appending an ellipsis when clipped. */
function truncateLine(line: string, max = MAX_COMPLETED_LINE): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

/**
 * Compose the markdown handover brief seeded as the fresh orchestrated
 * conversation's first user turn. Pure — output depends only on its args. Section
 * headings are STABLE (unit tests key off them):
 *   - `# Workflow handover` preamble.
 *   - `## Completed so far` — one line per step_results row (truncated).
 *   - `## Remaining steps` — definition steps with no 'done' row, in definition
 *     order; a previously-skipped/failed step is marked inline.
 *   - `## Workflow instructions` — the full promptBody verbatim (or a note when null).
 *   - `## The user's request that triggered this handover` — the reason verbatim +
 *     the "address this first" directive.
 */
export function composeHandoverPrompt(input: HandoverPromptInput): string {
  const { runId, workflowName, promptBody, steps, stepResults, reason } = input;

  // Map each step id → the outcome of its LAST recorded row (later attempts win),
  // so "done" detection and the previously-skipped/failed markers stay consistent.
  const lastOutcomeByStep = new Map<string, string>();
  for (const r of stepResults) {
    lastOutcomeByStep.set(r.stepId, r.outcome);
  }

  const preamble =
    `# Workflow handover\n\n` +
    `You are taking over run \`${runId}\` of the **${workflowName}** workflow mid-flight. ` +
    `The programmatic step controller that was walking this run's steps is now DETACHED — ` +
    `you drive the remaining work CONVERSATIONALLY from here. ` +
    `Report step progress via the \`cyboflow_report_step\` MCP tool as you complete each step, ` +
    `and make all entity writes through the \`cyboflow_*\` MCP tools as usual.`;

  // ## Completed so far — one line per step_results row (all rows, in order).
  let completedBody: string;
  if (stepResults.length === 0) {
    completedBody = '- (no steps recorded yet)';
  } else {
    completedBody = stepResults
      .map((r) => {
        const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
        const error = typeof r.error === 'string' ? r.error.trim() : '';
        const detail = summary.length > 0 ? summary : error.length > 0 ? error : '';
        const line = `- ${r.stepId}: ${r.outcome}${detail ? ` — ${detail}` : ''}`;
        return truncateLine(line);
      })
      .join('\n');
  }
  const completedSection = `## Completed so far\n\n${completedBody}`;

  // ## Remaining steps — definition steps whose LAST outcome is not 'done', in
  // definition order. A skipped/failed row counts as remaining, marked inline.
  const remaining = steps.filter((step) => lastOutcomeByStep.get(step.id) !== 'done');
  let remainingBody: string;
  if (remaining.length === 0) {
    remainingBody = '- (all defined steps have completed)';
  } else {
    remainingBody = remaining
      .map((step) => {
        const outcome = lastOutcomeByStep.get(step.id);
        const marker =
          outcome === 'skipped'
            ? ' (previously skipped)'
            : outcome === 'failed'
              ? ' (previously failed)'
              : '';
        return `- ${step.id} — ${step.name}${marker}`;
      })
      .join('\n');
  }
  const remainingSection = `## Remaining steps\n\n${remainingBody}`;

  // ## Workflow instructions — the full prompt body verbatim, or a note when null.
  const instructionsBody =
    promptBody !== null && promptBody.trim().length > 0
      ? promptBody
      : 'The workflow prompt body was unavailable; proceed from the remaining step list above.';
  const instructionsSection = `## Workflow instructions\n\n${instructionsBody}`;

  // ## The user's request that triggered this handover — the reason verbatim.
  const requestSection =
    `## The user's request that triggered this handover\n\n${reason}\n\n` +
    `Address this request first, then continue the remaining workflow steps.`;

  return [preamble, completedSection, remainingSection, instructionsSection, requestSection].join('\n\n');
}
