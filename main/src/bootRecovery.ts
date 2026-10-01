/**
 * bootRecovery — the boot-time recovery run, extracted from index.ts's
 * app.whenReady() block (GitHub issue #19, the god-file split, step 20). It
 * runs right after the ApprovalRouter / QuestionRouter bridges are wired and
 * sweeps whatever a previous process left behind, in this order: stale
 * awaiting_input (QuestionRouter) → stale awaiting_review (ApprovalRouter) →
 * archived-session run orphans → active-state orphans → the Sentry aggregate
 * of app_restart force-fails → orphaned verification requests → the
 * programmatic and orchestrated crash-safe resume re-drives → the interrupted-
 * outcome reclassification → the archived-session review-item backfill → the
 * terminal-outcome backfill → the usage backfills (fire-and-forget) → the
 * stale derived-stage sweep → the landed-sprint close-out backfill → the
 * design-handoff recovery. The body is index.ts's verbatim, apart from its
 * inputs arriving as deps; it is `async` because the original sequence awaits
 * (the call site awaits it, so every later wiring still observes a finished
 * recovery exactly as before).
 *
 * No getters: runQueues, runExecutor and databaseService are assigned exactly
 * once in initializeServices(), which app.whenReady() awaits before this runs,
 * and never reassigned; db and loggerLike are whenReady-local consts.
 *
 * A SIBLING of index.ts on purpose — composition-root code that reaches for
 * concrete services, so it must stay OUT of main/src/orchestrator/** (the
 * standalone-typecheck invariant scans that tree). No unit test, as there was
 * none over the inline block; runRecovery.ts, runUsageBackfill.ts and the
 * routers' recovery methods carry their own suites.
 *
 * ORDER IS LOAD-BEARING, inside and at the call site: the archived-session
 * sweep must precede recoverActiveStateOrphans (see its comment), the outcome
 * backfills must follow the orphan sweeps, and the whole run must follow
 * ApprovalRouter.initialize / QuestionRouter.initialize and precede the
 * run dep-bag wiring below the call site.
 */

import { ApprovalRouter } from './orchestrator/approvalRouter';
import { QuestionRouter } from './orchestrator/questionRouter';
import { TaskChangeRouter } from './orchestrator/taskChangeRouter';
import { VerificationScheduler } from './orchestrator/verify/verificationScheduler';
import { DesignHandoffService } from './orchestrator/design/designHandoffService';
import { recoverDesignHandoffs } from './orchestrator/design/designHandoffRecovery';
import { captureSeamError } from './services/telemetry';
import { backfillLandedSprintCloseOuts } from './ipc/gitOps';
import {
  recoverActiveStateOrphans,
  recoverArchivedSessionRunOrphans,
  backfillArchivedSessionReviewItems,
  backfillInterruptedOutcomes,
  backfillTerminalOutcomes,
} from './orchestrator/runRecovery';
import { runBootUsageBackfills } from './orchestrator/runUsageBackfill';
import { replayCodexRunUsage } from './services/panels/codex/codexUsageReplay';
import type { RunQueueRegistry } from './orchestrator/RunQueueRegistry';
import type { RunExecutor } from './orchestrator/runExecutor';
import type { DatabaseService } from './database/database';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

export interface BootRecoveryDeps {
  db: DatabaseLike;
  loggerLike: LoggerLike;
  runQueues: RunQueueRegistry;
  runExecutor: RunExecutor;
  databaseService: DatabaseService;
}

export async function runBootRecovery(deps: BootRecoveryDeps): Promise<void> {
  const { db, loggerLike, runQueues, runExecutor, databaseService } = deps;

  // Boot recovery: any awaiting_input rows from a previous session have a dead SDK session.
  // Split counts: `resumable` are rested in awaiting_review (nudge-resumable, NOT a
  // force-fail); `failed` are force-failed with app_restart. Only `failed` feeds the
  // boot-recovery force-fail aggregate below.
  const staleQuestionsRecovered = QuestionRouter.getInstance().recoverStaleAwaitingInput();
  if (staleQuestionsRecovered.resumable + staleQuestionsRecovered.failed > 0) {
    console.log(
      `[Main] Recovered ${staleQuestionsRecovered.resumable + staleQuestionsRecovered.failed} stale awaiting_input run(s) on boot ` +
        `(${staleQuestionsRecovered.resumable} resumable, ${staleQuestionsRecovered.failed} failed)`,
    );
  }

  // Boot recovery: any awaiting_review rows from a previous session have a dead socket.
  const recoveredCount = ApprovalRouter.getInstance().recoverStaleAwaitingReview();
  if (recoveredCount > 0) {
    console.log(`[Main] Recovered ${recoveredCount} stale awaiting_review run(s) on boot`);
  }

  // Boot recovery: runs orphaned by an archived (dismissed) session. Left
  // non-terminal (e.g. 'stuck' from before the dismiss-cascade existed) they
  // keep showing in the active-runs rail. Cancel them so the rail's
  // terminal-status filter hides them — self-healing for any dismiss that
  // failed to cancel a hosted run. Runs BEFORE recoverActiveStateOrphans so an
  // archived-session orphan is already 'canceled' (off the candidate SELECT) and
  // can never be picked for orchestrated resume — which would otherwise race this
  // sweep and spawn an SDK subprocess into a deleted worktree.
  const archivedOrphanRecovery = recoverArchivedSessionRunOrphans(db);
  if (archivedOrphanRecovery.runsCanceled > 0) {
    console.log(`[Main] Canceled ${archivedOrphanRecovery.runsCanceled} run(s) orphaned by archived sessions (approvals canceled: ${archivedOrphanRecovery.approvalsCanceled})`);
  }

  // Boot recovery: any running/starting rows from a previous process have no live
  // executor — the SDK iterator and PTY are gone. Resume the resumable ones
  // (programmatic re-walk, or a fresh SDK `--resume` turn for orchestrated runs
  // with a live worktree + fresh Claude resume target); force-fail the rest as
  // interrupted (app_restart).
  const orphanRecovery = recoverActiveStateOrphans(db, runQueues);
  if (
    orphanRecovery.runningRecovered > 0 ||
    orphanRecovery.startingRecovered > 0 ||
    orphanRecovery.approvalsCanceled > 0
  ) {
    console.log(`[Main] Recovered active-state orphans (running: ${orphanRecovery.runningRecovered}, starting: ${orphanRecovery.startingRecovered}, approvals canceled: ${orphanRecovery.approvalsCanceled})`);
  }

  // Report boot-recovery force-fails to Sentry as ONE aggregate event (these
  // runs were reclassified interrupted with the synthetic 'app_restart' reason —
  // the prior process crashed, so no per-run error object exists). Count is
  // bucketed to keep tag cardinality low; a spike here signals frequent unclean
  // shutdowns. Includes ALL three app_restart force-fail paths: stale
  // awaiting_review (recoveredCount), the UNRESUMABLE active-state orphans
  // (runningRecovered/startingRecovered exclude the resumed programmatic AND
  // orchestrated runs, which were reset — not failed), AND the FAILED
  // (unresumable) subset of stale awaiting_input — but NOT the resumable
  // awaiting_input runs, which are rested in awaiting_review rather than failed.
  const bootForceFailed =
    recoveredCount +
    orphanRecovery.runningRecovered +
    orphanRecovery.startingRecovered +
    staleQuestionsRecovered.failed;
  if (bootForceFailed > 0) {
    const countBucket =
      bootForceFailed === 1 ? '1' : bootForceFailed <= 5 ? '2-5' : bootForceFailed <= 20 ? '6-20' : '20+';
    captureSeamError(
      'boot-recovery-force-failed',
      new Error(`${bootForceFailed} run(s) reclassified interrupted on boot recovery (app_restart, unresumable)`),
      { errorClass: 'app-restart', recoveryReason: 'app_restart', countBucket },
    );
  }

  // Boot recovery: verification_requests left 'leased'/'running' by a prior
  // process have no live scheduler worker (the in-memory AbortController + lease +
  // detached promise died with that process), so they cannot resume — re-drain
  // them to 'timeout'. Mirrors recoverActiveStateOrphans for the visual-verify
  // queue; runs once on the freshly-initialized singleton before any nudge.
  const verifyOrphans = await VerificationScheduler.getInstance().runRecovery();
  if (verifyOrphans > 0) {
    console.log(`[Main] Re-drained ${verifyOrphans} orphaned verification request(s) to timeout on boot`);
  }

  // Crash-safe resume (Stage 3): re-drive PROGRAMMATIC runs the previous process
  // left mid-walk. recoverActiveStateOrphans reset them to 'starting' (NOT
  // force-failed); re-enqueue each on its per-run queue, threading the persisted
  // current_step_id so the WorkflowController fast-forwards past completed steps
  // and a gate re-attaches to its still-pending review item. Fire-and-forget +
  // per-run try/catch, mirroring runLauncher.
  if (orphanRecovery.programmaticToResume.length > 0) {
    console.log(`[Main] Resuming ${orphanRecovery.programmaticToResume.length} programmatic run(s) after restart`);
    for (const { id, currentStepId, completedStepIds } of orphanRecovery.programmaticToResume) {
      if (currentStepId) runExecutor.setPendingResumeStep(id, currentStepId);
      if (completedStepIds.length > 0) runExecutor.setPendingCompletedSteps(id, completedStepIds);
      const queue = runQueues.getOrCreate(id);
      void queue.add(async () => {
        try {
          await runExecutor.execute(id);
        } catch (err) {
          loggerLike.error('[Main] programmatic resume re-drive failed', {
            runId: id,
            error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          });
        }
      });
    }
  }

  // Crash-safe resume, ORCHESTRATED arm: re-drive single-conversation SDK runs
  // the previous process left running/starting. recoverActiveStateOrphans reset
  // them to 'starting' (NOT force-failed) after verifying a fresh Claude resume
  // target + surviving worktree. setPendingResume makes execute() thread the
  // captured external session id as `--resume` (mirrors resumeRunHandler's
  // orchestrated arm); fire-and-forget — each is one cold SDK spawn whose turn
  // drains to awaiting_review on its own.
  if (orphanRecovery.orchestratedToResume.length > 0) {
    console.log(`[Main] Resuming ${orphanRecovery.orchestratedToResume.length} orchestrated run(s) after restart`);
    for (const { id } of orphanRecovery.orchestratedToResume) {
      runExecutor.setPendingResume(id);
      const queue = runQueues.getOrCreate(id);
      void queue.add(async () => {
        try {
          await runExecutor.execute(id);
        } catch (err) {
          loggerLike.error('[Main] orchestrated resume re-drive failed', {
            runId: id,
            error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          });
        }
      });
    }
  }

  // Boot recovery: reclassify historical app_restart force-fails as
  // outcome='interrupted' BEFORE the generic terminal-outcome backfill, so the
  // failed-stamp below only sees the remaining real (non-app_restart) failures.
  // Widened guard (outcome IS NULL OR 'failed') reclaims rows an earlier boot's
  // backfillTerminalOutcomes already stamped 'failed' — safe because the
  // app_restart sentinel is written only by the three boot-recovery seams.
  const interruptedBackfilled = backfillInterruptedOutcomes(db);
  if (interruptedBackfilled > 0) {
    console.log(`[Main] Reclassified ${interruptedBackfilled} historical app_restart run(s) as outcome='interrupted'`);
  }

  // Boot backfill: older archived sessions may still own pending review items.
  // Dismiss them through the ReviewItemRouter chokepoint (never raw SQL),
  // fail-soft per row so one bad item cannot block startup.
  const archivedReviewItemBackfill = await backfillArchivedSessionReviewItems(db, loggerLike);
  if (archivedReviewItemBackfill.itemsDismissed > 0 || archivedReviewItemBackfill.itemsFailed > 0) {
    console.log(
      `[Main] Backfilled archived-session review items (dismissed: ${archivedReviewItemBackfill.itemsDismissed}, failed: ${archivedReviewItemBackfill.itemsFailed})`,
    );
  }

  // Boot recovery: stamp outcome on failed/canceled runs that never got one
  // (kills mid-phase, pre-instrumentation rows) so the Insights success-rate
  // stats are trustworthy. Deliberately runs AFTER the two orphan sweeps
  // above — they transition orphans to failed/canceled, and this pass then
  // backfills those fresh rows' outcomes in the same boot. completed+NULL
  // rows are intentionally untouched (awaiting a close-out decision).
  const outcomeBackfill = backfillTerminalOutcomes(db);
  if (outcomeBackfill.failedBackfilled > 0 || outcomeBackfill.canceledBackfilled > 0) {
    console.log(`[Main] Backfilled terminal outcomes (failed: ${outcomeBackfill.failedBackfilled}, canceled: ${outcomeBackfill.canceledBackfilled})`);
  }

  // Insights Phase-2 (migration 026) self-heal. rollupRunUsage is wired only to
  // runExecutor's terminal lifecycle hook, but ~8 other writers can put a run
  // into a terminal status (cancel handlers, questionRouter, the trpc close-outs,
  // the merge path, and the orphan sweeps just above) — each leaves the run's
  // usage living ONLY in raw_events. Insights hides this behind its raw_events
  // fallback, so the gap is invisible until that log is pruned. Sweeping the
  // invariant here covers every writer at once, including future ones. Must run
  // AFTER the orphan sweeps + outcome backfill so runs force-terminated on this
  // boot are materialized in the same pass. Chained after the usage accounting
  // v1 backfill (migration 146), NOT awaited: see runBootUsageBackfills.
  const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const replayCodexRun = (runId: string) =>
    replayCodexRunUsage(databaseService.getDb(), runId, { notifiedBefore: processStartedAt });
  void runBootUsageBackfills(db, { replayCodexRun }, loggerLike);

  // Boot self-heal (migration 066): the derived 'In development' stage projects
  // a task's live run associations, and the recovery sweeps above force-fail
  // runs with raw UPDATEs (no per-task recompute). Recompute every task parked
  // at a derived stage AFTER those sweeps so a task whose runs died with the
  // app reverts to its entry stage instead of reading as in-development forever.
  // Fail-soft: a sweep error must never block boot.
  try {
    await TaskChangeRouter.getInstance().sweepStaleDerivedStageTasks();
  } catch (sweepErr) {
    console.warn('[Main] stale derived-stage sweep failed (continuing boot):', sweepErr instanceof Error ? sweepErr.message : String(sweepErr));
  }

  await backfillLandedSprintCloseOuts(databaseService, loggerLike); // TASK-296, see its own doc
  // Boot recovery (Design Mode v0): drive any design_handoffs left mid-Approve by
  // a previous process (state intent/snapshotted/folded) forward through the SAME
  // step functions the first-run approve uses — a crash after the body fold cannot
  // strand the operation (design-mode.md "Approve" Recovery). Non-fatal: the sweep
  // is itself per-row fail-soft, and any top-level error is logged, never blocks boot.
  try {
    const designRecovery = await recoverDesignHandoffs(DesignHandoffService.getInstance().depsBag);
    if (designRecovery.completed > 0 || designRecovery.unresolved > 0 || designRecovery.errored > 0) {
      console.log(
        `[Main] Recovered design handoffs (completed: ${designRecovery.completed}, unresolved: ${designRecovery.unresolved}, errored: ${designRecovery.errored})`,
      );
    }
  } catch (designErr) {
    console.warn('[Main] design-handoff recovery failed (continuing boot):', designErr instanceof Error ? designErr.message : String(designErr));
  }
}
