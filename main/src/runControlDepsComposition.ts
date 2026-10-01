/**
 * runControlDepsComposition — the run-control tRPC dep wiring, extracted from
 * index.ts's app.whenReady() block (GitHub issue #19, the god-file split,
 * step 22). It wires, in this order: the whenReady-scope Q1 draft sweep
 * (deletePendingDraftsForRun), runs.cancelAndRestart, the git-neutral
 * runs.cancel bag, the session-dismiss hosted-run cancel, runs.pause,
 * runs.resume, runs.reopen, runs.retryStep, and the reviewItems run-execution
 * probe. The body is index.ts's verbatim, apart from:
 *
 * - `cancelHostedRunsImpl` (index.ts's module holder, read LAZILY by the
 *   services bag's cancelHostedRuns closure) is now a same-named const,
 *   RETURNED and assigned at the call site right after this runs; nothing
 *   reads the holder synchronously in between, so the later assignment is
 *   unobservable.
 * - The two dep bags later wiring shares — `cancelRunDepsBag` (experiments'
 *   cancelRun) and `retryRunDepsBag` (the monitor's retry_step) — are
 *   RETURNED as well.
 *
 * No getters: runQueues, runExecutor and substrateFacade are assigned exactly
 * once in initializeServices(), which app.whenReady() awaits before this runs,
 * and never reassigned; db and loggerLike are whenReady-local consts and
 * prototypeServerReaper is a module const.
 *
 * A SIBLING of index.ts on purpose — composition-root code that reaches for
 * router singletons and concrete services, so it must stay OUT of
 * main/src/orchestrator/** (the standalone-typecheck invariant scans that
 * tree). No unit test, as there was none over the inline block; the run
 * handlers carry their own suites.
 *
 * ORDER IS LOAD-BEARING at the call site: after ApprovalRouter / QuestionRouter
 * initialize and boot recovery, and before the monitor-actuation and
 * experiments wiring that consume the returned bags.
 */

import { ApprovalRouter } from './orchestrator/approvalRouter';
import { QuestionRouter } from './orchestrator/questionRouter';
import { TaskChangeRouter } from './orchestrator/taskChangeRouter';
import { HumanStepManager } from './orchestrator/humanStepManager';
import { SprintLaneStore } from './orchestrator/sprintLaneStore';
import { StepResultStore } from './orchestrator/stepResultStore';
import { VerificationScheduler } from './orchestrator/verify/verificationScheduler';
import { cancelRunHandler, type CancelRunDeps } from './orchestrator/cancelRunHandler';
import type { RetryRunDeps } from './orchestrator/retryRunHandler';
import { runStatusEvents } from './orchestrator/trpc/routers/events';
import {
  setCancelAndRestartDeps,
  setCancelRunDeps,
  setPauseRunDeps,
  setResumeRunDeps,
  setReopenRunDeps,
  setRetryRunDeps,
} from './orchestrator/trpc/routers/runs';
import { setReviewItemsRunProbe } from './orchestrator/trpc/routers/reviewItems';
import { TERMINAL_RUN_STATUSES_SQL_IN } from '../../shared/types/cyboflow';
import { getCyboflowSubdirectory } from './utils/cyboflowDirectory';
import type { PrototypeServerReaper } from './services/prototypeServerReaper';
import type { RunQueueRegistry } from './orchestrator/RunQueueRegistry';
import type { RunExecutor } from './orchestrator/runExecutor';
import type { SubstrateDispatchFacade } from './services/substrateDispatchFacade';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

export interface RunControlDepsCompositionDeps {
  db: DatabaseLike;
  loggerLike: LoggerLike;
  runQueues: RunQueueRegistry;
  runExecutor: RunExecutor;
  substrateFacade: SubstrateDispatchFacade;
  prototypeServerReaper: PrototypeServerReaper;
}

export interface RunControlDepsComposition {
  /** The runs.cancel bag — experiments' cancelRun reuses it. */
  cancelRunDepsBag: CancelRunDeps;
  /** The runs.retryStep bag — the monitor's retry_step reuses it. */
  retryRunDepsBag: RetryRunDeps;
  /** index.ts's cancelHostedRunsImpl holder (session dismiss → cancel hosted runs). */
  cancelHostedRunsImpl: (sessionId: string) => Promise<void>;
}

export function composeRunControlDeps(deps: RunControlDepsCompositionDeps): RunControlDepsComposition {
  const { db, loggerLike, runQueues, runExecutor, substrateFacade, prototypeServerReaper } = deps;

  // Known limitation: ApprovalRouter.clearPendingForRun is still a documented no-op
  // until TASK-304 lands. The Cancel-and-restart button therefore stops the Claude
  // SDK run and updates DB rows, but does not yet send deny-replies on the
  // permission socket. See approvalRouter.ts:328–337.
  // Q1 GUARD sweep (this scope): the initializeServices-scope twin backs the
  // lifecycle 'failed' seam; the two cannot share a closure (sibling scopes), so
  // the cancel / cancel-and-restart dep-bags close over this local copy. Drops a
  // torn-down run's PENDING draft entities — deleteRunCreatedEntities self-gates
  // on plan_approved_at IS NULL + keys on run_id.
  const deletePendingDraftsForRun = async (runId: string): Promise<void> => {
    const r = db
      .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
      .get(runId) as { projectId?: number } | undefined;
    if (!r || typeof r.projectId !== 'number') return;
    await TaskChangeRouter.getInstance().deleteRunCreatedEntities(r.projectId, runId);
  };

  setCancelAndRestartDeps({
    db,
    approvalRouter: ApprovalRouter.getInstance(),
    questionRouter: QuestionRouter.getInstance(),
    runQueues,
    // Provider-neutral stop (runtime-mix plan D6): route through the SAME
    // SubstrateDispatchFacade.abort seam runs.cancel uses below, which resolves
    // the manager that actually spawned the run's panel. The previous
    // defaultCliManager.stopPanel binding was Claude-only, so a codex-primary
    // (or interactive) run's process survived the cancel half of
    // cancel-and-restart while the row was replaced underneath it.
    managerStop: (runId: string) => substrateFacade.abort(runId),
    // F5: sweep the OLD run's pending drafts after it flips 'canceled'.
    deletePendingDraftsForRun,
    // Migration 066: the OLD run flips 'canceled' but the replacement run carries
    // no task/batch link, so revert the old run's batch lanes + direct task off
    // 'In development' to their entry stage (fail-soft inside the handler).
    recomputeTasksForBatch: (batchId: string) =>
      TaskChangeRouter.getInstance().recomputeTasksForBatch(batchId),
    recomputeTask: (taskId: string) =>
      TaskChangeRouter.getInstance().recomputeTaskExecutionStage(taskId),
    logger: loggerLike,
  });
  console.log('[Main] cancelAndRestart deps wired');

  // Phase 4a — git-neutral run Cancel. Stops the live agent on BOTH substrates
  // by routing through the SubstrateDispatchFacade kill seam
  // (substrateFacade.abort), NOT defaultCliManager.stopPanel (SDK-only — would
  // orphan an interactive run's PTY). abort() resolves the manager that spawned
  // the run's panel and calls killProcess on it — the SDK manager overrides
  // killProcess to abort its query() iterator, the interactive manager inherits
  // it to kill the PTY tree — so a single call stops whichever substrate ran.
  // (killSession targets a run's persistent live process at close-out; abort()
  // is still the canonical universal-cancel seam.) Reuses the SAME `db`, `runQueues`,
  // ApprovalRouter / QuestionRouter accessors, and `loggerLike` as the
  // cancelAndRestart wiring above. emitRunStatusChanged emits on the SAME
  // module-level `runStatusEvents` 'changed' channel the lifecycleTransitions
  // adapter uses, so the rail / action-bar (activeRunsStore) reacts to a cancel.
  // The bag has NO worktree collaborator — cancel never touches git.
  const cancelRunDepsBag = {
    db,
    runQueues,
    // stopLiveRun also aborts a PROGRAMMATIC run's host-driven WorkflowController
    // (requestProgrammaticCancel) — substrateFacade.abort alone only kills the
    // current step, leaving the controller to spawn the next one / a gate to hang.
    // requestProgrammaticCancel is synchronous + a no-op for orchestrated runs.
    stopLiveRun: async (runId: string) => {
      runExecutor.requestProgrammaticCancel(runId);
      await substrateFacade.abort(runId);
    },
    clearPendingApprovalsForRun: (runId: string) =>
      ApprovalRouter.getInstance().clearPendingForRun(runId),
    clearPendingQuestionsForRun: (runId: string) =>
      QuestionRouter.getInstance().clearPendingForRun(runId),
    clearPendingHumanGatesForRun: (runId: string) =>
      HumanStepManager.getInstance().clearPendingForRun(runId),
    emitRunStatusChanged: (runId: string, status: 'canceled') =>
      runStatusEvents.emit('changed', { runId, status }),
    // Batch close-out (single-run parallel sprint): cancelling a sprint batch
    // run flips its sprint_batches row terminal too, so the lane substrate
    // never strands non-terminal.
    markBatchTerminal: (batchId: string, status: 'canceled') =>
      SprintLaneStore.getInstance().markBatchTerminal(batchId, status),
    // Migration 066: after the cancel + batch close-out, revert the batch's
    // non-integrated lanes off 'In development' to their entry stage.
    recomputeTasksForBatch: (batchId: string) =>
      TaskChangeRouter.getInstance().recomputeTasksForBatch(batchId),
    // Migration 066: a DIRECTLY task-linked run (workflow_runs.task_id, no batch)
    // reverts its task off 'In development' too. Load-bearing for session dismiss
    // (cancelHostedRuns → cancelRunHandler), which never recomputes otherwise.
    recomputeTask: (taskId: string) =>
      TaskChangeRouter.getInstance().recomputeTaskExecutionStage(taskId),
    // Q1 GUARD: after a successful cancel, drop the run's PENDING draft entities
    // (epics + orphan tasks it created pre-approval) so a torn-down plan leaves
    // no orphans. Shares the single deletePendingDraftsForRun sweep defined at the
    // cancelAndRestart wiring above (self-gated on plan_approved_at IS NULL).
    deletePendingDraftsForRun,
    // Visual-verify cleanup: abort in-flight captures/judges + mark the run's
    // non-terminal verification_requests rows 'timeout'. tryGetInstance keeps it
    // a no-op if the scheduler was never initialized; fail-soft inside the handler.
    cancelVerificationsForRun: (runId: string) =>
      VerificationScheduler.tryGetInstance()?.cancelForRun(runId),
    // TASK-057: a cancelled run must reap its detached ui-prototype http.server
    // too. Fail-soft is handled inside cancelRunHandler.
    reapPrototypeServers: (runId: string) =>
      prototypeServerReaper.reapForRun(getCyboflowSubdirectory('artifacts', 'runs', runId)),
    logger: loggerLike,
  };
  setCancelRunDeps(cancelRunDepsBag);
  console.log('[Main] runs.cancel deps wired');

  // Session Dismiss → cancel hosted runs (consumed by sessions:delete via the
  // services bag). Every NON-terminal run on the session goes through the SAME
  // git-neutral cancelRunHandler as the runs.cancel mutation — settling pending
  // approvals/questions (no orphaned review-queue items), stopping the live
  // agent, and closing a sprint run's lane batch. Per-run fail-soft: one bad
  // run must not block dismissing the session.
  const cancelHostedRunsImpl = async (sessionId: string): Promise<void> => {
    const rows = db
      .prepare(
        `SELECT id FROM workflow_runs
            WHERE session_id = ? AND status NOT IN ${TERMINAL_RUN_STATUSES_SQL_IN}`,
      )
      .all(sessionId) as Array<{ id: string }>;
    for (const row of rows) {
      try {
        await cancelRunHandler(row.id, cancelRunDepsBag);
      } catch (err: unknown) {
        loggerLike.error('[Main] session dismiss: cancel of hosted run failed', {
          sessionId,
          runId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  console.log('[Main] session-dismiss hosted-run cancel wired');

  // Phase 4b — SDK-only Pause/Resume. Pause is the NON-terminal twin of Cancel:
  // it stops the active SDK turn (via the SAME substrateFacade.abort kill seam)
  // and parks the run in `paused`, PRESERVING claude_session_id +
  // current_step_id. It reuses the SAME `db`, `runQueues`, ApprovalRouter /
  // QuestionRouter accessors, and `loggerLike` as the Cancel wiring above, and
  // emits on the SAME `runStatusEvents` 'changed' channel so the rail /
  // action-bar (activeRunsStore) reacts. Like Cancel the bag has NO worktree
  // collaborator — Pause never touches git. SDK-only is enforced inside the
  // handler (it refuses a non-sdk run before any kill / DB write).
  setPauseRunDeps({
    db,
    runQueues,
    stopLiveRun: (runId: string) => substrateFacade.abort(runId),
    // PROGRAMMATIC pause: signal the WorkflowController walk (the handler
    // enforces walk-first ordering, BEFORE stopLiveRun) so the interrupted
    // step reports 'aborted' — not a clean 'ok' — and the walk stops spawning
    // subsequent steps while the row parks in 'paused'. Synchronous; a no-op
    // for orchestrated runs (no entry in the executor's aborts map).
    abortProgrammaticWalk: (runId: string) => runExecutor.requestProgrammaticCancel(runId),
    clearPendingApprovalsForRun: (runId: string) =>
      ApprovalRouter.getInstance().clearPendingForRun(runId),
    clearPendingQuestionsForRun: (runId: string) =>
      QuestionRouter.getInstance().clearPendingForRun(runId),
    emitRunStatusChanged: (runId, status) =>
      runStatusEvents.emit('changed', { runId, status }),
    logger: loggerLike,
  });
  console.log('[Main] runs.pause deps wired');

  // Resume re-drives the SAME SDK conversation via the executor's --resume path.
  // It uses the SAME module-scoped RunExecutor instance nudge uses (so the
  // executor's pendingResume / pendingNudge maps are shared), flips the run
  // paused -> running, and re-drives execute(runId) with the executor marked for
  // resume (continue prompt + claude_session_id threaded as the SDK resume id).
  // emitRunStatusChanged rides the SAME runStatusEvents 'changed' channel.
  setResumeRunDeps({
    db,
    runQueues,
    runExecutor,
    // PROGRAMMATIC resume: persisted done/skipped step ids (migration 033) so
    // the re-driven WorkflowController skips completed steps and resumes at
    // the interrupted one. Unused by the orchestrated --resume arm.
    completedStepIds: (runId: string) =>
      StepResultStore.tryGetInstance()?.completedStepIds(runId) ?? [],
    emitRunStatusChanged: (runId, status) =>
      runStatusEvents.emit('changed', { runId, status }),
    logger: loggerLike,
  });
  console.log('[Main] runs.resume deps wired');

  // Reopen revives a FAILED run (session reopen-on-timeout follow-up): flips
  // failed -> running, clears the failure stamp, and re-drives the SAME SDK
  // conversation via --resume with the user's text (using the SAME RunExecutor
  // instance + pendingNudge map as nudge). Same deps shape as Resume; rides the
  // SAME runStatusEvents 'changed' channel.
  setReopenRunDeps({
    db,
    runQueues,
    runExecutor,
    emitRunStatusChanged: (runId, status) =>
      runStatusEvents.emit('changed', { runId, status }),
    logger: loggerLike,
  });
  console.log('[Main] runs.reopen deps wired');

  // Retry-from-step revives a FAILED (or resting awaiting_review) PROGRAMMATIC
  // run at a chosen/derived step via the crash-safe resume machinery — the
  // fourth sanctioned terminal revive (stateMachine.ts rationale). Shares the
  // SAME RunExecutor + runStatusEvents channel as resume/reopen; step_results
  // reads ride StepResultStore; the fan-out lane reset rides SprintLaneStore so
  // a retried fan-out step re-dispatches its failed lanes instead of skipping
  // them as settled.
  const retryRunDepsBag: RetryRunDeps = {
    db,
    runQueues,
    runExecutor,
    emitRunStatusChanged: (runId, status) =>
      runStatusEvents.emit('changed', { runId, status }),
    listStepResults: (runId) => StepResultStore.tryGetInstance()?.listForRun(runId) ?? [],
    resetFailedLanes: (batchId) => SprintLaneStore.getInstance().resetFailedLanes(batchId),
    reopenBatch: (batchId) => SprintLaneStore.getInstance().reopenBatch(batchId),
    logger: loggerLike,
  };
  setRetryRunDeps(retryRunDepsBag);
  console.log('[Main] runs.retryStep deps wired');

  // Drained-rest race guard (reviewItems.resolve/dismiss trailing auto-resume):
  // the trailing maybeResumeRun must never revive a run whose walk has ENDED —
  // when the resolved gate was the run's LAST step, the walk finishes and rests
  // the run in awaiting_review before the trailing call runs, and a resume then
  // strands it 'running' with no live walk. The probe is the SAME
  // hasActiveExecution the retry pre-flight consumes.
  setReviewItemsRunProbe({
    hasActiveExecution: (runId) => runExecutor.hasActiveExecution(runId),
  });
  console.log('[Main] reviewItems run-execution probe wired');

  return { cancelRunDepsBag, retryRunDepsBag, cancelHostedRunsImpl };
}
