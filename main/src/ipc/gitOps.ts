/**
 * Concrete implementation of {@link SessionGitOpsLike} — the business logic
 * behind the `cyboflow.sessionGit` tRPC router (slice 3, the final slice, of
 * the IPC→tRPC migration; docs/CODE-PATTERNS.md).
 *
 * The 20 renderer-facing `sessions:*` / `git:*` git handlers moved here VERBATIM
 * from main/src/ipc/git.ts (now deleted) — the only changes are mechanical: each
 * registration of a channel handler taking `(_event, a, b)` became
 * `const <method> = async ({ a, b }) => {…}` with the same body, and the
 * closures are returned as one object at the end. `sessions:check-rebase-conflicts`
 * was dropped (zero preload/frontend callers); the conflict probe itself lives
 * on in WorktreeManager.checkForRebaseConflicts, which rebaseMainIntoWorktree
 * still calls directly.
 *
 * Unlike the router and contract, this file is SERVICES-SIDE and may import
 * anything — the panel manager, the main window, the orchestrator routers, the
 * run-recovery stampers. That asymmetry is the whole point of the seam.
 */
import type { AppServices } from './types';
import type { DatabaseService } from '../database/database';
import type { LoggerLike } from '../orchestrator/types';
import type { SessionGitOpsLike, SessionGitDiffStats } from '../orchestrator/trpc/contracts/sessionGitOps';
import { runGit, runGitAsync, END_OF_OPTIONS } from '../utils/runGit';
import { appendCommitFooter } from '../utils/commitFooter';
import { panelManager } from '../services/panelManager';
import { mainWindow } from '../index';
import { panelEventBus } from '../services/panelEventBus';
import { PanelEventType, ToolPanelType, PanelEvent } from '../../../shared/types/panels';
import { DynamicWorkflowTracker } from '../orchestrator/dynamicWorkflows';
import type { Session } from '../types/session';
import type { GitCommit } from '../services/gitDiffManager';
import { readUntrackedFileContent, createUntrackedFileDiffBlock } from '../services/gitDiffManager';
import { WorktreeChangeNotifier } from '../services/worktreeChangeNotifier';
import type { ExecException } from 'child_process';
import { TaskChangeRouter } from '../orchestrator/taskChangeRouter';
import { ArtifactRouter } from '../orchestrator/artifactRouter';
import { SprintLaneStore } from '../orchestrator/sprintLaneStore';
import {
  stampSessionRunsOutcome,
  stampSessionRunsPrOpen,
  stampSessionRunsCompleted,
  sessionDeliveredWork,
  sessionCompletedNoCodeWork,
} from '../orchestrator/runRecovery';
import { trackUsage } from '../services/telemetry';
import { makeDatabaseLike } from '../orchestrator/loggerAdapter';
import { ALREADY_UP_TO_DATE_CODE } from '../services/worktreeManager';
import { getCurrentBranch as readCurrentBranch } from '../services/gitPlumbingCommands';
import { resolveSessionDiffBaseRef } from './sessionFileStats';
import type { WorktreeStatusPayload, DiffGroupScope } from '../../../shared/types/runFiles';
import * as fs from 'fs';
import * as path from 'path';

// Extended type for git system virtual panels
type SystemPanelType = ToolPanelType | 'git';

// Interface for custom git errors that contain additional context
interface GitError extends Error {
  gitCommands?: string[];
  gitOutput?: string;
  workingDirectory?: string;
  projectPath?: string;
  originalError?: Error;
}

/**
 * Whether `worktreePath` is itself the root of the repo git resolves from it,
 * rather than a plain directory sitting inside some enclosing checkout. Guards
 * the branch read in getCurrentBranch — see the comment there for why a bare
 * read is a confidently-wrong answer instead of an error.
 */
function isOwnRepoRoot(worktreePath: string): boolean {
  try {
    const toplevel = runGit(worktreePath, ['rev-parse', '--show-toplevel']).trim();
    if (!toplevel) return false;
    // realpathSync.native, not the JS realpath: on Windows only the native call
    // expands 8.3 short names (C:\Users\RUNNER~1\…) and canonicalises case, and
    // git prints the toplevel long-named with forward slashes, so the JS variant
    // compares two spellings of the same directory and answers false.
    return fs.realpathSync.native(toplevel) === fs.realpathSync.native(worktreePath);
  } catch {
    // Not a repo, or the directory is gone — either way there is no branch to show.
    return false;
  }
}

/**
 * Whether a thrown merge error is the "branch has nothing left to give main"
 * case (WorktreeManager tags it with ALREADY_UP_TO_DATE_CODE and carries the tag
 * through its GitError wrap). Matched on the code, never the message.
 */
function isAlreadyUpToDate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === ALREADY_UP_TO_DATE_CODE
  );
}

// Interface for process errors that have stdout/stderr properties
interface ProcessError {
  stdout?: string;
  stderr?: string;
  message?: string;
}

// Interface for generic error objects with git-related properties
interface ErrorWithGitContext {
  gitCommand?: string;
  gitCommands?: string[];
  gitOutput?: string;
  workingDirectory?: string;
  originalError?: Error;
  [key: string]: unknown;
}

// Interface for raw commit data from worktreeManager
interface RawCommitData {
  hash: string;
  message: string;
  date: string | Date;
  author?: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
}


/**
 * The request shape of one ops method, taken from the contract itself so the
 * two can never drift.
 */
type OpsInput<K extends keyof SessionGitOpsLike> = Parameters<SessionGitOpsLike[K]>[0];

/**
 * The resolved envelope of one ops method, taken from the contract. Annotating
 * each closure with it is what CONTEXTUALLY types the `return { success: … }`
 * literals inside — without it TypeScript widens `success: true` to `boolean`
 * and no envelope shape would be checked at all.
 */
type OpsResult<K extends keyof SessionGitOpsLike> = Awaited<ReturnType<SessionGitOpsLike[K]>>;

// ---------------------------------------------------------------------------
// Sprint close-out on session merge (feat/parallel-sprint, single-run lane
// model). MODULE SCOPE (TASK-296): the squash/rebase merge handlers, the
// markComplete op, and the boot backfill all reach these through
// {@link closeOutSessionAfterLanding} / directly — one code path, so a
// session whose branch landed OUTSIDE the app (merged/rebased by hand) gets
// the exact same treatment as an in-app merge instead of a bookkeeping-only
// stamp.
// ---------------------------------------------------------------------------

/**
 * A sprint run executes in the SESSION worktree; merging the session to main
 * IS the sprint's merge close-out. For every batch-linked run hosted by the
 * merged session: each lane whose status is 'integrated' moves its task to
 * the done stage via the TaskChangeRouter chokepoint (mirrors
 * recomputeTaskExecutionStage's outcome='merged' arm: board position 9, kind
 * 'execution-stage', actor 'orchestrator'), then the batch is marked
 * 'completed'. Entirely fail-soft: a task-side or batch-side failure is
 * logged and NEVER affects the merge result (the git operation already
 * succeeded). Lanes that are failed/blocked/queued are deliberately left
 * alone — their tasks revert/stay per the normal stage rules.
 */
export async function finalizeSprintLanesOnSessionMerge(databaseService: DatabaseService, sessionId: string): Promise<void> {
  try {
    const db = databaseService.getDb();
    const batchRuns = db
      .prepare('SELECT id, batch_id FROM workflow_runs WHERE session_id = ? AND batch_id IS NOT NULL')
      .all(sessionId) as Array<{ id: string; batch_id: string }>;
    if (batchRuns.length === 0) return;

    const laneStore = SprintLaneStore.getInstance();
    const taskRouter = TaskChangeRouter.getInstance();

    for (const run of batchRuns) {
      const lanes = laneStore.listLanes(run.batch_id);
      for (const lane of lanes) {
        if (lane.status !== 'integrated') continue;
        try {
          const task = db
            .prepare('SELECT id, project_id, board_id, stage_id FROM tasks WHERE id = ?')
            .get(lane.taskId) as
            | { id: string; project_id: number; board_id: string; stage_id: string }
            | undefined;
          if (!task) {
            // After experiments.decide's lane remap (experiments.ts remapWinnerSeedLane),
            // an A/B winner's lanes point at ORIGINAL task ids, never swept clones — so a
            // missing task here should never fire for an experiment run. If it does, a lane
            // still references a deleted clone: a real signal (defect a), not noise.
            console.warn(
              `[IPC:git] sprint close-out: lane task ${lane.taskId} (batch ${run.batch_id}) has no tasks row ` +
                '— skipping (unexpected for an experiment run after decide lane remap)'
            );
            continue;
          }
          // DONE_POSITION = 9 — same stage resolution as TaskChangeRouter.
          // recomputeTaskExecutionStage's outcome='merged' arm.
          const doneStage = db
            .prepare('SELECT id FROM board_stages WHERE board_id = ? AND position = ?')
            .get(task.board_id, 9) as { id: string } | undefined;
          if (!doneStage || doneStage.id === task.stage_id) continue;
          await taskRouter.applyChange(task.project_id, {
            actor: 'orchestrator',
            entityType: 'task',
            taskId: lane.taskId,
            stageId: doneStage.id,
            kind: 'execution-stage',
          });
        } catch (taskError) {
          console.error(
            `[IPC:git] sprint close-out: failed to move task ${lane.taskId} to done (continuing):`,
            taskError
          );
        }
      }
      try {
        laneStore.markBatchTerminal(run.batch_id, 'completed');
      } catch (batchError) {
        console.error(
          `[IPC:git] sprint close-out: failed to mark batch ${run.batch_id} completed (continuing):`,
          batchError
        );
      }
      // Recompute the batch's tasks (migration 066) so NON-integrated lanes
      // (queued/failed/blocked) revert off 'In development' to their entry stage.
      // The terminal-stage guard in recomputeTaskExecutionStage protects the
      // just-Done tasks moved above (this runs BEFORE stampSessionRunsOutcome
      // stamps outcome='merged', so a Done task must not be yanked back). Fail-
      // soft — the merge already succeeded.
      try {
        await taskRouter.recomputeTasksForBatch(run.batch_id);
      } catch (recomputeError) {
        console.error(
          `[IPC:git] sprint close-out: failed to recompute batch ${run.batch_id} task stages (continuing):`,
          recomputeError
        );
      }
    }
  } catch (error) {
    console.error(
      `[IPC:git] sprint close-out after session merge failed for session ${sessionId} (merge unaffected):`,
      error
    );
  }
}

/**
 * Re-derive the board stages a session's runs drove, AFTER a close-out has
 * stamped those runs terminal / merged. Needed because the run-status flips
 * happen OUTSIDE the TaskChangeRouter chokepoint (stampSessionRunsPrOpen /
 * stampSessionRunsOutcome raw-UPDATE workflow_runs), so nothing recomputes the
 * derived 'In development' stage (migration 066) afterward:
 *   • A DIRECT task-linked run (workflow_runs.task_id, no batch) is never touched
 *     by finalizeSprintLanesOnSessionMerge (batch-only) — arm 1 lands its task on
 *     Done on merge here, instead of waiting for the next boot sweep.
 *   • A BATCH run's lanes were recomputed by finalizeSprintLanesOnSessionMerge
 *     while its run was still non-terminal (arm 2 held non-integrated tasks at
 *     'In development'); re-running now the run is terminal reverts them to their
 *     entry stage (pr_open ≠ merged). The terminal-stage guard in
 *     recomputeTaskExecutionStage protects the just-Done integrated tasks.
 * Entirely fail-soft + per-run isolated — the git operation already succeeded.
 */
export async function recomputeSessionRunTaskStages(databaseService: DatabaseService, sessionId: string): Promise<void> {
  try {
    const db = databaseService.getDb();
    const runs = db
      .prepare('SELECT batch_id, task_id FROM workflow_runs WHERE session_id = ?')
      .all(sessionId) as Array<{ batch_id: string | null; task_id: string | null }>;
    if (runs.length === 0) return;
    const taskRouter = TaskChangeRouter.getInstance();
    const seenBatches = new Set<string>();
    for (const run of runs) {
      if (run.batch_id && !seenBatches.has(run.batch_id)) {
        seenBatches.add(run.batch_id);
        try {
          await taskRouter.recomputeTasksForBatch(run.batch_id);
        } catch (batchError) {
          console.error(
            `[IPC:git] close-out recompute: batch ${run.batch_id} failed (continuing):`,
            batchError
          );
        }
      }
      if (run.task_id) {
        try {
          await taskRouter.recomputeTaskExecutionStage(run.task_id);
        } catch (taskError) {
          console.error(
            `[IPC:git] close-out recompute: task ${run.task_id} failed (continuing):`,
            taskError
          );
        }
      }
    }
  } catch (error) {
    console.error(
      `[IPC:git] close-out recompute failed for session ${sessionId} (git operation unaffected):`,
      error
    );
  }
}

/**
 * The FULL sprint close-out for a session whose work has genuinely landed on
 * main (TASK-296) — used by every path that reaches that conclusion: the
 * in-app squash/rebase merge handlers (via `stampMergedOutcomeForSession`,
 * below) AND `markComplete` when its server-side re-probe of the delivery
 * state (`WorktreeManager.getBranchLandingState`) proves the branch already
 * landed by hand. Runs the SAME three steps an in-app merge always ran:
 *
 *   1. finalizeSprintLanesOnSessionMerge — integrated lanes -> Done stage,
 *      batch -> 'completed' terminal.
 *   2. stampSessionRunsOutcome(sessionId, 'merged', mergeSha) — outcome IS
 *      NULL guard, so a run that already recorded its own decision is never
 *      clobbered.
 *   3. recomputeSessionRunTaskStages — re-derives the board stage a DIRECT
 *      task-linked run drove, and reverts non-integrated batch lanes off
 *      'In development' now the runs are terminal.
 *
 * Fail-soft throughout (see each step above); returns the number of runs
 * actually stamped so callers can log/report it.
 */
export async function closeOutSessionAfterLanding(
  databaseService: DatabaseService,
  sessionId: string,
  opts: { mergeSha?: string },
): Promise<{ stampedRuns: number }> {
  await finalizeSprintLanesOnSessionMerge(databaseService, sessionId);
  let stampedRuns = 0;
  try {
    stampedRuns = stampSessionRunsOutcome(makeDatabaseLike(databaseService), sessionId, 'merged', opts.mergeSha);
  } catch (error) {
    console.error(`[IPC:git] Failed to stamp merged outcome for session ${sessionId}:`, error);
  }
  await recomputeSessionRunTaskStages(databaseService, sessionId);
  return { stampedRuns };
}

/**
 * How many of a session's INTEGRATED sprint lanes have NOT (yet) reached the
 * board's Done stage — the "would have moved to Done had the branch actually
 * landed" count. Used by:
 *   - `markComplete`'s `laneTasksLeftOpen` response field, when it stamps
 *     `outcome='completed'` WITHOUT running the close-out (branch not landed) —
 *     so the caller/dialog can say "N sprint tasks were NOT marked done
 *     because the branch isn't on main" instead of silently stranding them.
 *   - `backfillLandedSprintCloseOuts`'s boot-log task count.
 * Read-only; never mutates a lane or a task. Fail-soft: any read error
 * reports 0 rather than throwing.
 */
export function countIntegratedLaneTasksNotYetDone(databaseService: DatabaseService, sessionId: string): number {
  try {
    const db = databaseService.getDb();
    const batchRuns = db
      .prepare('SELECT id, batch_id FROM workflow_runs WHERE session_id = ? AND batch_id IS NOT NULL')
      .all(sessionId) as Array<{ id: string; batch_id: string }>;
    if (batchRuns.length === 0) return 0;
    const laneStore = SprintLaneStore.getInstance();
    let count = 0;
    for (const run of batchRuns) {
      for (const lane of laneStore.listLanes(run.batch_id)) {
        if (lane.status !== 'integrated') continue;
        const task = db
          .prepare('SELECT stage_id, board_id FROM tasks WHERE id = ?')
          .get(lane.taskId) as { stage_id: string; board_id: string } | undefined;
        if (!task) continue;
        const doneStage = db
          .prepare('SELECT id FROM board_stages WHERE board_id = ? AND position = ?')
          .get(task.board_id, 9) as { id: string } | undefined;
        if (doneStage && doneStage.id !== task.stage_id) count++;
      }
    }
    return count;
  } catch (error) {
    console.error(`[IPC:git] failed to count integrated lane tasks for session ${sessionId}:`, error);
    return 0;
  }
}

/**
 * Boot backfill (TASK-296): before this task, `markComplete` on a session
 * whose branch had ALREADY landed (merged/rebased by hand outside the app)
 * only stamped `outcome='completed'` — it never ran the lane-finalize
 * close-out an in-app merge performs, so a batch's `integrated` lanes stayed
 * wherever the sprint left them instead of moving to Done. This is a
 * ONE-SHOT sweep (mirrors the boot-backfill pattern in
 * main/src/orchestrator/runRecovery.ts, wired at the same boot site in
 * main/src/index.ts) to heal rows written under that old behaviour.
 *
 * Trigger, DB-only (cheaper and good-enough per the task spec — no git
 * re-probe at boot): a run with `outcome='completed'`, a `batch_id`,
 * `merge_sha IS NULL`, and at least one 'integrated' lane whose task has not
 * reached the board's Done stage yet. Re-runs ONLY the lane/task side
 * (finalizeSprintLanesOnSessionMerge + recomputeSessionRunTaskStages) —
 * deliberately does NOT touch `outcome`: 'completed' is already a
 * DELIVERED_RUN_OUTCOMES value, and rewriting it to 'merged' at boot would be
 * an unearned upgrade of history this sweep has no fresh evidence for.
 *
 * Guarded off any session that is still live: a run still in flight for the
 * SAME session owns its own close-out path and must never be raced by a boot
 * sweep; the `sessions` row (if it still exists — a dismissed session's row
 * may already be gone) must not read 'running', 'waiting', or 'initializing'
 * either.
 *
 * Fail-soft + per-session isolated. Idempotent: a lane already on Done fails
 * the trigger predicate on the next boot, so a second run finds no
 * candidates. Logs what it fixed.
 */
export async function backfillLandedSprintCloseOuts(
  databaseService: DatabaseService,
  logger: Pick<LoggerLike, 'info' | 'error'> = {
    info: (message: string, context?: Record<string, unknown>) => console.log(message, context ?? ''),
    error: (message: string, context?: Record<string, unknown>) => console.error(message, context ?? ''),
  },
): Promise<{ sessionsFixed: number; tasksMoved: number }> {
  const empty = { sessionsFixed: 0, tasksMoved: 0 };
  try {
    const db = databaseService.getDb();
    const candidates = db
      .prepare(
        `SELECT DISTINCT wr.session_id AS sessionId
           FROM workflow_runs wr
           JOIN sprint_batch_tasks sbt ON sbt.batch_id = wr.batch_id
           JOIN tasks t ON t.id = sbt.task_id
           JOIN board_stages bs ON bs.board_id = t.board_id AND bs.position = 9
          WHERE wr.outcome = 'completed'
            AND wr.batch_id IS NOT NULL
            AND wr.merge_sha IS NULL
            AND wr.session_id IS NOT NULL
            AND sbt.status = 'integrated'
            AND t.stage_id != bs.id
            AND NOT EXISTS (
              SELECT 1 FROM sessions s
               WHERE s.id = wr.session_id
                 AND s.status IN ('running', 'waiting', 'initializing')
            )
            AND NOT EXISTS (
              SELECT 1 FROM workflow_runs wr2
               WHERE wr2.session_id = wr.session_id
                 AND wr2.status NOT IN ('completed', 'failed', 'canceled')
            )`,
      )
      .all() as Array<{ sessionId: string }>;
    if (candidates.length === 0) return empty;

    let sessionsFixed = 0;
    let tasksMoved = 0;
    for (const { sessionId } of candidates) {
      try {
        const stillOpen = countIntegratedLaneTasksNotYetDone(databaseService, sessionId);
        await finalizeSprintLanesOnSessionMerge(databaseService, sessionId);
        await recomputeSessionRunTaskStages(databaseService, sessionId);
        if (stillOpen > 0) {
          sessionsFixed++;
          tasksMoved += stillOpen;
        }
      } catch (sessionError) {
        logger.error(`[Main] boot backfill: landed sprint close-out for session ${sessionId} failed (continuing)`, {
          sessionId,
          error: sessionError instanceof Error ? sessionError.message : String(sessionError),
        });
      }
    }
    if (tasksMoved > 0) {
      logger.info(
        `[Main] Boot backfill: closed out ${sessionsFixed} landed sprint session(s), moved ${tasksMoved} task(s) to Done`,
      );
    }
    return { sessionsFixed, tasksMoved };
  } catch (error) {
    logger.error('[Main] boot backfill for landed sprint close-outs failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
}

export function createGitOps(services: AppServices): SessionGitOpsLike {
  const { sessionManager, gitDiffManager, worktreeManager, gitStatusManager, databaseService, configManager, endLiveSession } = services;

  // Quick-session close-out (IDEA-030): after a merge/rebase the session's work
  // is accepted, so a live persistent chat process should exit instead of
  // lingering orphaned — this now applies on EITHER substrate. `endLiveSession`
  // is the SubstrateDispatchFacade.endSession seam: for the interactive REPL it
  // writes a graceful EOF/`/exit` (claude is idle post-merge and reads PTY
  // stdin) and translates the chat `__quick__` sentinel runId to the live
  // panelId; for the SDK substrate (a warm persistent query() under
  // SDK-process persistence) it dispatches the same killProcess abort used by
  // killSession, since there is no PTY stdin to write a graceful EOF into.
  // Fire-and-forget fail-soft: a close failure must never fail the git
  // operation itself. Role-G: the live process gates on the chatRunId sentinel
  // (the gate vehicle), not runId (the latest flow run).
  const endLiveSessionProcesses = (session: Session, sessionId: string): void => {
    if (!session.chatRunId) return;
    void endLiveSession(session.chatRunId).catch((err: unknown) => {
      console.warn(`[IPC:git] Failed to end live session process for session ${sessionId}:`, err);
    });
  };

  // Helper function to emit git operation events to all sessions in a project
  const emitGitOperationToProject = (sessionId: string, eventType: PanelEventType, message: string, details?: Record<string, unknown>) => {
    try {
      const session = sessionManager.getSession(sessionId);
      if (!session) return;
      
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) return;
      
      // Create a virtual event as if it came from the git system
      const event = {
        type: eventType,
        source: {
          panelId: 'git-system', // Special panel ID for git operations
          panelType: 'git' as SystemPanelType, // Virtual panel type
          sessionId: sessionId // The session that triggered the operation
        },
        data: {
          message,
          triggeringSessionId: sessionId,
          triggeringSessionName: session.name,
          projectId: project.id,
          ...details
        },
        timestamp: new Date().toISOString()
      };
      
      // Emit the event once to the panel event bus
      // All Claude panels that have subscribed will receive it
      panelEventBus.emitPanelEvent(event as PanelEvent);

      // Also forward to renderer so UI components listening for window 'panel:event' receive it
      try {
        if (mainWindow) {
          mainWindow.webContents.send('panel:event', event);
        }
      } catch (ipcError) {
        console.error('[Git] Failed to forward git operation event to renderer:', ipcError);
      }
    } catch (error) {
      console.error('[Git] Failed to emit git operation event:', error);
    }
  };

  // Sprint close-out on session merge (feat/parallel-sprint, single-run lane
  // model), plus the outcome-stamping + recompute that follow it. Moved to
  // MODULE SCOPE above (TASK-296) as finalizeSprintLanesOnSessionMerge /
  // recomputeSessionRunTaskStages / closeOutSessionAfterLanding so markComplete
  // and the boot backfill can reach the SAME close-out an in-app merge runs,
  // instead of duplicating it. `stampMergedOutcomeForSession` below is this
  // closure's thin binder: it resolves the merge SHA from the project's
  // checked-out worktree (squash/rebase-specific — an in-app merge just
  // fast-forwarded/rebased the project root onto main) and delegates the rest.

  // After a successful session merge (squash or rebase), stamp outcome='merged'
  // on that session's child runs so the run-outcome stats (Insights) credit the
  // merge, and run the full lane/task close-out. Runs link via
  // workflow_runs.session_id — the sessionId here IS that key. Guarded by
  // `outcome IS NULL` inside stampSessionRunsOutcome, so a run that already
  // recorded its own decision is never clobbered.
  //
  // Fail-soft: a stamping failure is logged and never propagates — the merge has
  // already succeeded and its response must not depend on this bookkeeping.
  const stampMergedOutcomeForSession = async (sessionId: string, projectPath?: string) => {
    // A/B post-merge attribution (migration 049): after a successful merge the
    // project root is checked out on the just-updated main branch, so its HEAD is
    // the merge commit this session's code landed on. Compute it and stamp it onto
    // workflow_runs.merge_sha. Fail-soft: a SHA read failure leaves merge_sha NULL
    // (never blocks the merge). Covers both the squash and rebase callers.
    let mergeSha: string | undefined;
    if (projectPath) {
      try {
        mergeSha = await worktreeManager.getHeadCommit(projectPath);
      } catch (error) {
        console.error(`[IPC:git] Failed to read merged SHA for session ${sessionId}:`, error);
      }
    }
    const { stampedRuns } = await closeOutSessionAfterLanding(databaseService, sessionId, { mergeSha });
    if (stampedRuns > 0) {
      console.log(`[IPC:git] Stamped outcome='merged' on ${stampedRuns} run(s) for session ${sessionId}`);
    }
    // Merge close-out reached only after a successful squash/rebase merge.
    trackUsage('session_resolved', { action: 'merge', had_conflicts: false });
  };

  // Reap UNCOMMITTED run artifacts on a SESSION close-out that delivers work —
  // squash/rebase merge + create-PR (git-push) — for every run the session hosted
  // (IDEA-039). The run-scoped runs.merge/createPr close-out only fires for legacy
  // non-session-hosted runs (they assertNotSessionHosted), so a session-hosted run's
  // reap MUST happen here at the session seams instead. Delegates per run to
  // ArtifactRouter.reapForRun (deletes committed=0 rows + fs.rm's the run's
  // artifacts subtree); committed snapshots live in the project-root commit store
  // and survive. Entirely fail-soft + per-run isolated — the git operation already
  // succeeded, so this bookkeeping must never fail its response. Plain dismiss
  // (sessions:delete) deliberately does NOT call this — a dismiss-without-merge
  // intentionally leaks (accepted product decision, no GC sweep).
  const reapArtifactsForSessionClose = async (sessionId: string): Promise<void> => {
    try {
      const db = databaseService.getDb();
      const runs = db
        .prepare('SELECT id, project_id FROM workflow_runs WHERE session_id = ?')
        .all(sessionId) as Array<{ id: string; project_id: number }>;
      for (const run of runs) {
        try {
          await ArtifactRouter.getInstance().reapForRun(run.project_id, run.id);
        } catch (runError) {
          console.error(
            `[IPC:git] artifact reap failed for run ${run.id} (session ${sessionId}, continuing):`,
            runError,
          );
        }
      }
    } catch (error) {
      console.error(
        `[IPC:git] artifact reap after session close failed for session ${sessionId} (git operation unaffected):`,
        error,
      );
    }
  };

  // Helper function to refresh git status after operations that only affect one session
  const refreshGitStatusForSession = async (sessionId: string, isUserInitiated = false) => {
    try {
      await gitStatusManager.refreshSessionGitStatus(sessionId, isUserInitiated);
    } catch (error) {
      // Git status refresh failures are logged by GitStatusManager
    }
  };

  // Helper function to refresh git status for all sessions in a project (e.g. after updating main)
  const refreshGitStatusForProject = async (projectId: number) => {
    try {
      const sessions = await sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectId && !s.archived && s.status !== 'error');
      
      // Refresh all sessions in parallel
      await Promise.all(projectSessions.map(session => 
        gitStatusManager.refreshSessionGitStatus(session.id, false).catch(() => {
          // Individual failures are logged by GitStatusManager
        })
      ));
    } catch (error) {
      // Project-level refresh failures are rare and will be logged by GitStatusManager
    }
  };

  const getSessionCommitHistory = async (
    session: Session,
    limit: number = 50
  ): Promise<{
    commits: GitCommit[];
    mainBranch: string;
    comparisonBranch: string;
    historySource: 'remote' | 'local' | 'branch';
    limitReached: boolean;
  }> => {
    if (!session.worktreePath) {
      throw new Error('Session has no worktree path');
    }

    const project = sessionManager.getProjectForSession(session.id);
    if (!project?.path) {
      throw new Error('Project path not found for session');
    }

    const mainBranch = await worktreeManager.getProjectMainBranch(project.path);
    let comparisonBranch = mainBranch;
    let historySource: 'remote' | 'local' | 'branch' = 'branch';
    let useFallback = false;

    if (session.isMainRepo) {
      const originBranch = await worktreeManager.getOriginBranch(session.worktreePath, mainBranch);
      if (originBranch) {
        comparisonBranch = originBranch;
        historySource = 'remote';
      } else {
        historySource = 'local';
        comparisonBranch = mainBranch;
        useFallback = true;
      }
    } else if (session.baseCommit) {
      // Worktree sessions: compare against the branch point captured at session
      // creation, NOT the live main tip. Diffing against live main makes a
      // session's diff go blank after its commits are fast-forward-merged into
      // main (main advances to include them, so `main..HEAD` is empty even though
      // the session did real work). base_commit..HEAD is the stable "what this
      // session changed since it branched" view and survives merges. Falls back
      // to mainBranch below if the recorded base commit is no longer resolvable.
      comparisonBranch = session.baseCommit;
    }

    let commits: GitCommit[] = [];

    if (!useFallback) {
      try {
        commits = await gitDiffManager.getCommitHistory(session.worktreePath, limit, comparisonBranch);
      } catch (error) {
        if (session.isMainRepo) {
          console.warn(`[IPC:git] Falling back to local commit history for session ${session.id}:`, error);
          useFallback = true;
          historySource = 'local';
          comparisonBranch = mainBranch;
        } else if (comparisonBranch !== mainBranch) {
          // base_commit unresolvable (e.g. gc'd) — retry against main before giving up.
          console.warn(`[IPC:git] base_commit ${comparisonBranch} unresolvable for session ${session.id}; comparing against ${mainBranch}:`, error);
          comparisonBranch = mainBranch;
          commits = await gitDiffManager.getCommitHistory(session.worktreePath, limit, comparisonBranch);
        } else {
          throw error;
        }
      }
    }

    if (useFallback) {
      const fallbackLimit = limit;
      const fallbackCommits = await worktreeManager.getLastCommits(session.worktreePath, fallbackLimit);
      commits = fallbackCommits.map((commit: RawCommitData) => ({
        hash: commit.hash,
        message: commit.message,
        date: new Date(commit.date),
        author: commit.author || 'Unknown',
        stats: {
          additions: commit.additions || 0,
          deletions: commit.deletions || 0,
          filesChanged: commit.filesChanged || 0
        }
      }));
    }

    if (!session.isMainRepo) {
      historySource = 'branch';
    }

    const limitReached = commits.length === limit;

    return {
      commits,
      mainBranch,
      comparisonBranch,
      historySource,
      limitReached
    };
  };

  // ---------------------------------------------------------------------
  // Seam B (TASK-212): the `resolvedBase` + `worktree` envelope every
  // SessionGitDiffResult now carries, and the `scope`/`comparisonRef` wire
  // fields on getCombinedDiff.
  // ---------------------------------------------------------------------

  /**
   * Assemble the wire-level WorktreeStatusPayload (`entries` + per-scope
   * `groups` + `committedUnavailable`) for one worktree, from
   * GitDiffManager.getWorktreeStatus (TASK-209) and .getDiffGroups
   * (TASK-210). `resolvedBase` gates the Committed group only — null anchors
   * nothing and committedUnavailable comes back true; the other three groups
   * are always populated (see getDiffGroups's own doc comment).
   */
  const buildWorktreeStatus = async (
    worktreePath: string,
    resolvedBase: string | null,
  ): Promise<WorktreeStatusPayload> => {
    const [entries, diffGroups] = await Promise.all([
      gitDiffManager.getWorktreeStatus(worktreePath),
      gitDiffManager.getDiffGroups(worktreePath, resolvedBase),
    ]);
    return { entries, groups: diffGroups.groups, committedUnavailable: diffGroups.committedUnavailable };
  };

  /**
   * Resolve the base a getCombinedDiff response should anchor `resolvedBase`
   * / the Committed group on, in priority order: an explicit `comparisonRef`
   * (TASK-212 wire field — resolved to a SHA via the TASK-208 resolver before
   * it can reach any git argv; an unresolvable ref falls back to the session
   * default rather than throwing), else the session's recorded branch point
   * (`session.baseCommit`), else the comparison branch
   * getSessionCommitHistory already derives (remote/local/main-branch
   * fallback chain). Returns the resolved 40-char SHA, or null when nothing
   * resolves — the caller then has no base to diff since (the
   * working-dir-vs-HEAD rung).
   */
  const resolveCombinedDiffBase = async (
    session: Session,
    worktreePath: string,
    comparisonRef?: string,
  ): Promise<string | null> => {
    if (comparisonRef) {
      const resolved = await resolveSessionDiffBaseRef(worktreePath, [comparisonRef]);
      if (resolved) return resolved;
      console.warn(
        `[IPC:git] comparisonRef "${comparisonRef}" unresolvable in ${worktreePath}, falling back to the session default`,
      );
    }

    const fromBaseCommit = await resolveSessionDiffBaseRef(worktreePath, [session.baseCommit]);
    if (fromBaseCommit) return fromBaseCommit;

    try {
      const { comparisonBranch } = await getSessionCommitHistory(session, 50);
      return await resolveSessionDiffBaseRef(worktreePath, [comparisonBranch]);
    } catch (error) {
      console.warn(`[IPC:git] Could not resolve a comparison branch for session ${session.id}:`, error);
      return null;
    }
  };

  /**
   * Build the diff blob for one DiffGroupScope, using the SAME git query the
   * corresponding getDiffGroups rollup uses (TASK-212 spec item 5): plain
   * `git diff` for unstaged, `--cached` for staged, `<merge-base>..HEAD` for
   * committed, the synthesized untracked block for untracked.
   * GitDiffManager's own per-scope helpers (getStagedGroup / getUnstagedGroup
   * / getCommittedGroup / getUntrackedGroup / createDiffForUntrackedFiles)
   * are private and gitDiffManager.ts is do-not-touch for this task (widening
   * its GitDiffResult would drag in executionTracker.ts) — the argv/blob
   * construction is small enough to mirror here rather than adding a new
   * public seam to that file.
   */
  const buildScopedDiff = async (
    worktreePath: string,
    scope: DiffGroupScope,
    resolvedBase: string | null,
  ): Promise<{ diff: string; stats: SessionGitDiffStats; changedFiles: string[] }> => {
    const empty = { diff: '', stats: { additions: 0, deletions: 0, filesChanged: 0 }, changedFiles: [] as string[] };

    switch (scope) {
      case 'unstaged': {
        const diff = await runGitAsync(worktreePath, ['diff']);
        const changedFiles = (await runGitAsync(worktreePath, ['diff', '--name-only']))
          .trim().split('\n').filter(Boolean);
        const stats = gitDiffManager.parseDiffStats(await runGitAsync(worktreePath, ['diff', '--stat']));
        return { diff, stats, changedFiles };
      }
      case 'staged': {
        // `--diff-filter=u` (lowercase = exclude unmerged) mirrors
        // GitDiffManager.getStagedGroup: a conflicted path belongs to
        // Unstaged only, so the staged blob must not carry its "Unmerged
        // path" stub either.
        const diff = await runGitAsync(worktreePath, ['diff', '--cached', '--diff-filter=u']);
        const changedFiles = (await runGitAsync(worktreePath, ['diff', '--cached', '--name-only', '--diff-filter=u']))
          .trim().split('\n').filter(Boolean);
        const stats = gitDiffManager.parseDiffStats(
          await runGitAsync(worktreePath, ['diff', '--cached', '--stat', '--diff-filter=u']),
        );
        return { diff, stats, changedFiles };
      }
      case 'committed': {
        if (!resolvedBase) return empty;
        try {
          const mergeBase = (
            await runGitAsync(worktreePath, ['merge-base', END_OF_OPTIONS, resolvedBase, 'HEAD'])
          ).trim();
          if (!mergeBase) return empty;
          const range = `${mergeBase}..HEAD`;
          const diff = await runGitAsync(worktreePath, ['diff', END_OF_OPTIONS, range]);
          const changedFiles = (await runGitAsync(worktreePath, ['diff', '--name-only', END_OF_OPTIONS, range]))
            .trim().split('\n').filter(Boolean);
          const stats = gitDiffManager.parseDiffStats(
            await runGitAsync(worktreePath, ['diff', '--stat', END_OF_OPTIONS, range]),
          );
          return { diff, stats, changedFiles };
        } catch {
          // No common ancestor (unrelated histories) or the merge-base step
          // failed — never fall back to "the whole tree" (mirrors
          // GitDiffManager.getCommittedGroup).
          return empty;
        }
      }
      case 'untracked': {
        const listOutput = await runGitAsync(worktreePath, ['ls-files', '--others', '--exclude-standard']);
        const files = listOutput.trim().split('\n').filter((f) => f.trim().length > 0);
        let diff = '';
        let additions = 0;
        for (const file of files) {
          const cleanFile = file.trim();
          if (!cleanFile) continue;
          // The shared reader refuses symlinks / non-regular / oversize files
          // (returns null) — an untracked link to a file outside the worktree
          // must never have its target's contents rendered into the blob.
          const content = readUntrackedFileContent(worktreePath, cleanFile);
          if (content === null) continue;
          additions += content.split('\n').length;
          diff += createUntrackedFileDiffBlock(cleanFile, content);
        }
        return { diff, stats: { additions, deletions: 0, filesChanged: files.length }, changedFiles: files };
      }
    }
  };

  const getExecutions = async ({ sessionId }: OpsInput<'getExecutions'>): Promise<OpsResult<'getExecutions'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const { commits, comparisonBranch, historySource, limitReached } = await getSessionCommitHistory(session, 50);

      // Transform git commits to execution format expected by frontend
      const executions = commits.map((commit, index) => ({
        id: index + 1, // 1-based index for commits
        session_id: sessionId,
        execution_sequence: index + 1,
        after_commit_hash: commit.hash,
        commit_message: commit.message,
        timestamp: commit.date.toISOString(),
        stats_additions: commit.stats.additions,
        stats_deletions: commit.stats.deletions,
        stats_files_changed: commit.stats.filesChanged,
        author: commit.author,
        comparison_branch: comparisonBranch,
        history_source: historySource,
        history_limit_reached: limitReached
      }));

      // Check for uncommitted changes
      const hasUncommittedChanges = await gitDiffManager.hasChanges(session.worktreePath);
      if (hasUncommittedChanges) {
        // Get stats for uncommitted changes
        const uncommittedDiff = await gitDiffManager.captureWorkingDirectoryDiff(session.worktreePath);
        
        // Add uncommitted changes as execution with id 0
        executions.unshift({
          id: 0,
          session_id: sessionId,
          execution_sequence: 0,
          after_commit_hash: 'UNCOMMITTED',
          commit_message: 'Uncommitted changes',
          timestamp: new Date().toISOString(),
          stats_additions: uncommittedDiff.stats.additions,
          stats_deletions: uncommittedDiff.stats.deletions,
          stats_files_changed: uncommittedDiff.stats.filesChanged,
          author: 'You',
          comparison_branch: comparisonBranch,
          history_source: historySource,
          history_limit_reached: limitReached
        });
      }

      return { success: true, data: executions };
    } catch (error) {
      console.error('Failed to get executions:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get executions';
      return { success: false, error: errorMessage };
    }
  };

  const getExecutionDiff = async ({ sessionId, executionId }: OpsInput<'getExecutionDiff'>): Promise<OpsResult<'getExecutionDiff'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const { commits } = await getSessionCommitHistory(session, 50);
      const executionIndex = parseInt(executionId) - 1;

      if (executionIndex < 0 || executionIndex >= commits.length) {
        return { success: false, error: 'Invalid execution ID' };
      }

      // Get diff for the specific commit
      const commit = commits[executionIndex];
      const uncommittedDiff = await gitDiffManager.getCommitDiff(session.worktreePath, commit.hash);
      // getCommitDiff's own beforeHash is `${commitHash}~1` — a valid rev
      // expression but not a resolved SHA (the wire contract requires one).
      // Resolve it through the TASK-208 resolver; null (e.g. the commit has no
      // parent) falls back to the working-dir-vs-HEAD null rung rather than
      // leaking an unresolved rev string.
      const resolvedBase = await resolveSessionDiffBaseRef(session.worktreePath, [`${commit.hash}~1`]);
      const worktree = await buildWorktreeStatus(session.worktreePath, resolvedBase);
      return { success: true, data: { ...uncommittedDiff, resolvedBase, worktree } };
    } catch (error) {
      console.error('Failed to get execution diff:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get execution diff';
      return { success: false, error: errorMessage };
    }
  };

  const commit = async ({ sessionId, message }: OpsInput<'commit'>): Promise<OpsResult<'commit'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      // Check if there are any changes to commit
      const status = runGit(session.worktreePath, ['status', '--porcelain']).trim();

      if (!status) {
        return { success: false, error: 'No changes to commit' };
      }

      // Refuse to stage a conflicted tree. `git add -A` happily stages files
      // still carrying `<<<<<<<` markers and the commit below then records
      // them. The renderer's WorktreeStrip disables Commit on a conflicted
      // snapshot, but that snapshot is only as fresh as its last fetch — an
      // agent can drive the tree into a conflict between the dialog opening
      // and submit — so the authoritative check is HERE, at the mutation
      // boundary, against the live index. Same probe as
      // fastCheckWorkingDirectory (gitPlumbingCommands.ts).
      const conflicted = runGit(session.worktreePath, ['diff', '--name-only', '--diff-filter=U'])
        .trim()
        .split('\n')
        .filter(Boolean);
      if (conflicted.length > 0) {
        return {
          success: false,
          error: `Resolve conflicts before committing (${conflicted.length} unmerged: ${conflicted.slice(0, 5).join(', ')}${conflicted.length > 5 ? ', …' : ''})`,
        };
      }

      // Stage all changes
      runGit(session.worktreePath, ['add', '-A']);

      // Create the commit with Cyboflow's signature. The message is a plain argv
      // element, so it needs no shell escaping.
      const commitMessage = appendCommitFooter(message, configManager);

      try {
        runGit(session.worktreePath, ['commit', '-m', commitMessage]);

        // Refresh git status for this session after commit
        await refreshGitStatusForSession(sessionId);
        
        return { success: true };
      } catch (commitError: unknown) {
        // Check if it's a pre-commit hook failure
        if ((commitError && typeof commitError === 'object' && 'stdout' in commitError && (commitError as ProcessError).stdout?.includes('pre-commit')) || (commitError && typeof commitError === 'object' && 'stderr' in commitError && (commitError as ProcessError).stderr?.includes('pre-commit'))) {
          return { success: false, error: 'Pre-commit hooks failed. Please fix the issues and try again.' };
        }
        throw commitError;
      }
    } catch (error: unknown) {
      console.error('Failed to commit changes:', error);
      const errorMessage = (error instanceof Error ? error.message : '') || (error && typeof error === 'object' && 'stderr' in error ? (error as ProcessError).stderr : '') || 'Failed to commit changes';
      return { success: false, error: errorMessage };
    }
  };

  const diff = async ({ sessionId }: OpsInput<'diff'>): Promise<OpsResult<'diff'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }
      
      // Check if session is archived - worktree won't exist
      if (session.archived) {
        return { success: false, error: 'Cannot access git diff for archived session' };
      }

      const uncommittedDiff = await gitDiffManager.getGitDiff(session.worktreePath);
      // getGitDiff is the working-dir-vs-HEAD rung by definition — resolvedBase
      // is null here (see SessionGitDiffResult's doc comment), so Committed
      // comes back unavailable rather than anchored on a stand-in.
      const worktree = await buildWorktreeStatus(session.worktreePath, null);
      return { success: true, data: { ...uncommittedDiff, resolvedBase: null, worktree } };
    } catch (error) {
      // Don't log errors for expected failures
      const errorMessage = error instanceof Error ? error.message : 'Failed to get git diff';
      if (!errorMessage.includes('archived session')) {
        console.error('Failed to get git diff:', error);
      }
      return { success: false, error: errorMessage };
    }
  };

  const getCombinedDiff = async ({
    sessionId,
    executionIds,
    comparisonRef,
    scope,
  }: OpsInput<'getCombinedDiff'>): Promise<OpsResult<'getCombinedDiff'>> => {
    try {
      // Get session to find worktree path
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }
      const worktreePath = session.worktreePath;

      // `scope` (TASK-212) selects one DiffGroupScope's own git query for the
      // returned blob, and takes precedence over `executionIds` — it answers
      // "show me just the Staged/Unstaged/Untracked/Committed group", a
      // different question than the execution-range selector below.
      // `comparisonRef`, if supplied, overrides the base the Committed scope
      // (and resolvedBase itself) anchors on.
      if (scope) {
        const resolvedBase = await resolveCombinedDiffBase(session, worktreePath, comparisonRef);
        const scopedDiff = await buildScopedDiff(worktreePath, scope, resolvedBase);
        const worktree = await buildWorktreeStatus(worktreePath, resolvedBase);
        return { success: true, data: { ...scopedDiff, resolvedBase, worktree } };
      }

      // Handle uncommitted changes request
      if (executionIds && executionIds.length === 1 && executionIds[0] === 0) {
        // Verify the worktree exists and has uncommitted changes
        try {
          await runGitAsync(worktreePath, ['status', '--porcelain']);
        } catch (error) {
          console.error('Error checking git status:', error);
        }

        const uncommittedDiff = await gitDiffManager.captureWorkingDirectoryDiff(worktreePath);
        const worktree = await buildWorktreeStatus(worktreePath, null);
        return { success: true, data: { ...uncommittedDiff, resolvedBase: null, worktree } };
      }

      // No specific execution IDs: resolve the branch point directly instead of
      // deriving it from commit history. Going through getSessionCommitHistory's
      // `commits` array here used to mean a session with real edits but zero
      // commits of its own hit the `!commits.length` early return below and
      // showed nothing — exactly the "surface my uncommitted work" case this
      // view exists for. resolveCombinedDiffBase owns the fallback chain now
      // (comparisonRef, then session.baseCommit, then the
      // comparisonBranch/mainBranch getSessionCommitHistory already resolves);
      // captureWorkingDirectoryDiff (vs HEAD) remains the last resort, for a
      // worktree where nothing above resolves (e.g. a repo with no commits at
      // all, where HEAD itself is unborn).
      if (!executionIds || executionIds.length === 0) {
        const baseRef = await resolveCombinedDiffBase(session, worktreePath, comparisonRef);

        if (baseRef) {
          try {
            const result = await gitDiffManager.captureDiffAgainstRef(worktreePath, baseRef);
            const worktree = await buildWorktreeStatus(worktreePath, baseRef);
            return { success: true, data: { ...result, resolvedBase: baseRef, worktree } };
          } catch (error) {
            console.warn(`[IPC:git] captureDiffAgainstRef against ${baseRef} failed for session ${sessionId}, falling back to the working-directory diff:`, error);
          }
        }

        const uncommittedDiff = await gitDiffManager.captureWorkingDirectoryDiff(worktreePath);
        const worktree = await buildWorktreeStatus(worktreePath, null);
        return { success: true, data: { ...uncommittedDiff, resolvedBase: null, worktree } };
      }

      const { commits } = await getSessionCommitHistory(session, 50);

      if (!commits.length) {
        const worktree = await buildWorktreeStatus(worktreePath, null);
        return {
          success: true,
          data: {
            diff: '',
            stats: { additions: 0, deletions: 0, filesChanged: 0 },
            changedFiles: [],
            resolvedBase: null,
            worktree
          }
        };
      }

      // If we have a range selection (2 IDs), use git diff between them
      if (executionIds && executionIds.length === 2) {
        const sortedIds = [...executionIds].sort((a, b) => a - b);

        // Handle range that includes uncommitted changes
        if (sortedIds[0] === 0 || sortedIds[1] === 0) {
          // If uncommitted is in the range, get diff from the other commit to working directory
          const commitId = sortedIds[0] === 0 ? sortedIds[1] : sortedIds[0];
          const commitIndex = commitId - 1;

          if (commitIndex >= 0 && commitIndex < commits.length) {
            const fromCommit = commits[commitIndex];
            // Get diff from commit to working directory (includes uncommitted changes)
            const diff = await runGitAsync(worktreePath, ['diff', fromCommit.hash]);

            const stats = gitDiffManager.parseDiffStats(
              await runGitAsync(worktreePath, ['diff', '--stat', fromCommit.hash])
            );

            const changedFiles = (await runGitAsync(worktreePath, ['diff', '--name-only', fromCommit.hash]))
              .trim().split('\n').filter(Boolean);

            // The commit-range branches report their OWN from-hash as
            // resolvedBase, not the session base — fromCommit.hash is already
            // a resolved 40-char SHA (git log's %H).
            const worktree = await buildWorktreeStatus(worktreePath, fromCommit.hash);

            return {
              success: true,
              data: {
                diff,
                stats,
                changedFiles,
                beforeHash: fromCommit.hash,
                afterHash: 'UNCOMMITTED',
                resolvedBase: fromCommit.hash,
                worktree
              }
            };
          }
        }

        // For regular commit ranges, we want to show all changes introduced by the selected commits
        // - Commits are stored newest first (index 0 = newest)
        // - User selects from older to newer visually
        // - We need to go back one commit before the older selection to show all changes
        const newerIndex = sortedIds[0] - 1;   // Lower ID = newer commit
        const olderIndex = sortedIds[1] - 1;   // Higher ID = older commit

        if (newerIndex >= 0 && newerIndex < commits.length && olderIndex >= 0 && olderIndex < commits.length) {
          const newerCommit = commits[newerIndex]; // Newer commit
          const olderCommit = commits[olderIndex]; // Older commit

          // To show all changes introduced by the selected commits, we diff from
          // the parent of the older commit to the newer commit
          let fromCommitHash: string;

          try {
            // Try to get the parent of the older commit
            const parentHash = (await runGitAsync(worktreePath, ['rev-parse', `${olderCommit.hash}^`])).trim();
            fromCommitHash = parentHash;
          } catch (error) {
            // If there's no parent (initial commit), use git's empty tree hash
            fromCommitHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
          }

          // Use git diff to show all changes from before the range to the newest selected commit
          const uncommittedDiff = await gitDiffManager.captureCommitDiff(
            worktreePath,
            fromCommitHash,
            newerCommit.hash
          );
          const worktree = await buildWorktreeStatus(worktreePath, fromCommitHash);
          return { success: true, data: { ...uncommittedDiff, resolvedBase: fromCommitHash, worktree } };
        }
      }

      // For multiple individual selections, we need to create a range from first to last
      if (executionIds.length > 2) {
        const sortedIds = [...executionIds].sort((a, b) => a - b);
        const firstId = sortedIds[sortedIds.length - 1]; // Highest ID = oldest commit
        const lastId = sortedIds[0]; // Lowest ID = newest commit

        const fromIndex = firstId - 1;
        const toIndex = lastId - 1;

        if (fromIndex >= 0 && fromIndex < commits.length && toIndex >= 0 && toIndex < commits.length) {
          const fromCommit = commits[fromIndex]; // Oldest selected
          const toCommit = commits[toIndex]; // Newest selected

          const uncommittedDiff = await gitDiffManager.captureCommitDiff(
            worktreePath,
            fromCommit.hash,
            toCommit.hash
          );
          const worktree = await buildWorktreeStatus(worktreePath, fromCommit.hash);
          return { success: true, data: { ...uncommittedDiff, resolvedBase: fromCommit.hash, worktree } };
        }
      }

      // Single commit selection (but not uncommitted changes)
      if (executionIds.length === 1 && executionIds[0] !== 0) {
        const commitIndex = executionIds[0] - 1;
        if (commitIndex >= 0 && commitIndex < commits.length) {
          const commit = commits[commitIndex];
          const uncommittedDiff = await gitDiffManager.getCommitDiff(worktreePath, commit.hash);
          // getCommitDiff's own beforeHash (`${commitHash}~1`) is not a
          // resolved SHA — resolve it the same way getExecutionDiff does.
          const resolvedBase = await resolveSessionDiffBaseRef(worktreePath, [`${commit.hash}~1`]);
          const worktree = await buildWorktreeStatus(worktreePath, resolvedBase);
          return { success: true, data: { ...uncommittedDiff, resolvedBase, worktree } };
        }
      }

      // Fallback to empty diff
      const worktree = await buildWorktreeStatus(worktreePath, null);
      return {
        success: true,
        data: {
          diff: '',
          stats: { additions: 0, deletions: 0, filesChanged: 0 },
          changedFiles: [],
          resolvedBase: null,
          worktree
        }
      };
    } catch (error) {
      console.error('Failed to get combined diff:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to get combined diff';
      return { success: false, error: errorMessage };
    }
  };

  // Git rebase operations
  const rebaseMainIntoWorktree = async ({ sessionId }: OpsInput<'rebaseMainIntoWorktree'>): Promise<OpsResult<'rebaseMainIntoWorktree'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      // Get the main branch from the project directory's current branch
      const mainBranch = await Promise.race([
        worktreeManager.getProjectMainBranch(project.path),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getProjectMainBranch timeout')), 30000))
      ]) as string;

      // Check for conflicts before attempting rebase
      const conflictCheck = await worktreeManager.checkForRebaseConflicts(session.worktreePath, mainBranch);
      
      if (conflictCheck.hasConflicts) {
        
        // Build detailed error message
        let errorMessage = `Rebase would result in conflicts. Cannot proceed automatically.\n\n`;
        
        if (conflictCheck.conflictingFiles && conflictCheck.conflictingFiles.length > 0) {
          errorMessage += `Conflicting files:\n`;
          conflictCheck.conflictingFiles.forEach(file => {
            errorMessage += `  • ${file}\n`;
          });
          errorMessage += '\n';
        }
        
        if (conflictCheck.conflictingCommits) {
          if (conflictCheck.conflictingCommits.ours.length > 0) {
            errorMessage += `Your commits:\n`;
            conflictCheck.conflictingCommits.ours.slice(0, 5).forEach(commit => {
              errorMessage += `  ${commit}\n`;
            });
            if (conflictCheck.conflictingCommits.ours.length > 5) {
              errorMessage += `  ... and ${conflictCheck.conflictingCommits.ours.length - 5} more\n`;
            }
            errorMessage += '\n';
          }
          
          if (conflictCheck.conflictingCommits.theirs.length > 0) {
            errorMessage += `Incoming commits from ${mainBranch}:\n`;
            conflictCheck.conflictingCommits.theirs.slice(0, 5).forEach(commit => {
              errorMessage += `  ${commit}\n`;
            });
            if (conflictCheck.conflictingCommits.theirs.length > 5) {
              errorMessage += `  ... and ${conflictCheck.conflictingCommits.theirs.length - 5} more\n`;
            }
          }
        }
        
        // Emit git operation failed event for conflict detection
        const conflictMessage = `✗ Rebase aborted: Conflicts detected\n\n${errorMessage}`;
        emitGitOperationToProject(sessionId, 'git:operation_failed', conflictMessage, {
          operation: 'rebase_from_main',
          mainBranch,
          hasConflicts: true,
          conflictingFiles: conflictCheck.conflictingFiles
        });
        
        // Return detailed conflict information
        return {
          success: false,
          error: 'Rebase would result in conflicts',
          gitError: {
            command: `git rebase ${mainBranch}`,
            output: errorMessage,
            workingDirectory: session.worktreePath,
            hasConflicts: true,
            conflictingFiles: conflictCheck.conflictingFiles,
            conflictingCommits: conflictCheck.conflictingCommits
          }
        };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nRebasing from ${mainBranch}...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'rebase_from_main',
        mainBranch
      });

      await Promise.race([
        worktreeManager.rebaseMainIntoWorktree(session.worktreePath, mainBranch),
        new Promise((_, reject) => setTimeout(() => reject(new Error('rebaseMainIntoWorktree timeout')), 120000))
      ]);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully rebased ${mainBranch} into worktree`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'rebase_from_main',
        mainBranch
      });

      // Update git status directly after rebasing from main (more efficient than refresh)
      // Don't let this block the response - run it in background
      gitStatusManager.updateGitStatusAfterRebase(sessionId, 'from_main').catch(error => {
        console.error(`[IPC:git] Failed to update git status for session ${sessionId}:`, error);
      });

      return { success: true, data: { message: `Successfully rebased ${mainBranch} into worktree` } };
    } catch (error: unknown) {
      console.error(`[IPC:git] Failed to rebase main into worktree for session ${sessionId}:`, error);

      // Emit git operation failed event
      const errorMessage = `✗ Rebase failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (error && typeof error === 'object' && 'gitOutput' in error && (error as GitError).gitOutput ? `\n\nGit output:\n${(error as GitError).gitOutput}` : '');
      
      // Don't let this block the error response either
      try {
        emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
          operation: 'rebase_from_main',
          error: error instanceof Error ? error.message : String(error),
          gitOutput: error && typeof error === 'object' && 'gitOutput' in error ? (error as GitError).gitOutput : undefined
        });
      } catch (outputError) {
        console.error(`[IPC:git] Failed to emit git error event for session ${sessionId}:`, outputError);
      }

      // Pass detailed git error information to frontend
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rebase main into worktree',
        gitError: {
          command: error && typeof error === 'object' && 'gitCommand' in error ? (error as ErrorWithGitContext).gitCommand : undefined,
          output: error && typeof error === 'object' && 'gitOutput' in error ? (error as ErrorWithGitContext).gitOutput : (error instanceof Error ? error.message : String(error)),
          workingDirectory: error && typeof error === 'object' && 'workingDirectory' in error ? (error as ErrorWithGitContext).workingDirectory : undefined,
          originalError: error && typeof error === 'object' && 'originalError' in error ? (error as ErrorWithGitContext).originalError?.message : undefined
        }
      };
    }
  };

  const abortRebaseAndUseClaude = async ({ sessionId }: OpsInput<'abortRebaseAndUseClaude'>): Promise<OpsResult<'abortRebaseAndUseClaude'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      // Get the main branch from the project directory's current branch
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path);

      // Check if we're actually in a rebase state (could have been pre-detected conflicts)
      // Try to abort any existing rebase, but don't fail if there isn't one
      try {
        const statusOutput = runGit(session.worktreePath, ['status', '--porcelain=v1']);
        if (statusOutput.includes('rebase')) {
          await worktreeManager.abortRebase(session.worktreePath);
          
          // Emit git operation event about aborting the rebase
          const abortMessage = `🔄 GIT OPERATION\nAborted rebase successfully`;
          emitGitOperationToProject(sessionId, 'git:operation_completed', abortMessage, {
            operation: 'abort_rebase'
          });
        }
      } catch (abortError: unknown) {
        // Not in a rebase state or already clean - that's fine
      }

      // Create a new Claude panel to handle the rebase and conflicts
      const prompt = `Please rebase the local ${mainBranch} branch (not origin/${mainBranch}) into this branch and resolve all conflicts`;
      
      try {
        // Create a new Claude panel
        const panel = await panelManager.createPanel({
          sessionId: sessionId,
          type: 'claude',
          title: 'Chat - Resolve Conflicts'
        });
        
        // Get the claudePanelManager from the claudePanel module
        const { claudePanelManager } = require('./claudePanel');
        
        // Register the panel with the Claude panel manager
        claudePanelManager.registerPanel(panel.id, sessionId, panel.state.customState);
        
        // Start Claude in the new panel with the rebase prompt
        await claudePanelManager.startPanel(
          panel.id,
          session.worktreePath,
          prompt,
          session.permissionMode,
          session.model
        );
        
        // Add message to session output
        const message = `🤖 CLAUDE CODE\nCreated new Claude panel to handle rebase and resolve conflicts\nPrompt: ${prompt}`;
        sessionManager.addSessionOutput(sessionId, {
          type: 'stdout',
          data: message,
          timestamp: new Date()
        });
        
        return { 
          success: true, 
          data: { 
            message: 'Claude Code panel created to handle rebase and resolve conflicts',
            panelId: panel.id
          } 
        };
      } catch (error: unknown) {
        console.error('[IPC:git] Failed to create Claude panel:', error);
        console.error('[IPC:git] Error details:', {
          sessionId,
          worktreePath: session.worktreePath,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined
        });
        
        // Provide more specific error messages
        let errorMessage = 'Failed to create Claude panel';
        if (error instanceof Error && error.message?.includes('API key')) {
          errorMessage = 'Failed to create Claude panel: API key not configured';
        } else if (error instanceof Error && error.message?.includes('not found')) {
          errorMessage = 'Failed to create Claude panel: Session or worktree not found';
        } else if (error instanceof Error && error.message) {
          errorMessage = `Failed to create Claude panel: ${error.message}`;
        }
        
        return { success: false, error: errorMessage };
      }
    } catch (error: unknown) {
      console.error('[IPC:git] Failed to abort rebase and use Claude:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to abort rebase and use Claude'
      };
    }
  };

  const squashAndRebaseToMain = async ({ sessionId, commitMessage }: OpsInput<'squashAndRebaseToMain'>): Promise<OpsResult<'squashAndRebaseToMain'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch and project path
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      // Get the effective main branch (override or auto-detected)
      const mainBranch = await Promise.race([
        worktreeManager.getProjectMainBranch(project.path),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getProjectMainBranch timeout')), 30000))
      ]) as string;

      // Pre-merge guard: if main has advanced past this branch, a rebase is
      // needed first. We do NOT auto-rebase here — the merge methods would
      // silently rebase the worktree onto main (surprising the operator with
      // extra commits in the merge / PR). Block and report so the user can
      // rebase via chat, then merge.
      if (await worktreeManager.hasChangesToRebase(session.worktreePath, mainBranch)) {
        return {
          success: false,
          needsRebase: true,
          error: `${mainBranch} has new commits since this branch started. Rebase this worktree onto ${mainBranch} before merging — you can ask the agent to do it in chat.`,
        };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nSquashing commits and merging to ${mainBranch}...\nCommit message: ${commitMessage.split('\n')[0]}${commitMessage.includes('\n') ? '...' : ''}`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'squash_and_merge',
        mainBranch,
        commitMessage: commitMessage.split('\n')[0]
      });

      await Promise.race([
        worktreeManager.squashAndMergeWorktreeToMain(project.path, session.worktreePath, mainBranch, commitMessage),
        new Promise((_, reject) => setTimeout(() => reject(new Error('squashAndMergeWorktreeToMain timeout')), 180000))
      ]);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully squashed and merged worktree to ${mainBranch}`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'squash_and_merge',
        mainBranch
      });

      // Sprint close-out (feat/parallel-sprint): integrated lanes → done stage,
      // batch → completed, outcome='merged' stamped. Fail-soft — never affects
      // the merge result. (finalizeSprintLanesOnSessionMerge is folded into
      // stampMergedOutcomeForSession -> closeOutSessionAfterLanding, TASK-296.)
      await stampMergedOutcomeForSession(sessionId, project?.path);

      // Reap UNCOMMITTED run artifacts for every run this session hosted (IDEA-039).
      // Session-hosted runs can't close out via runs.merge (assertNotSessionHosted),
      // so their reap happens at this session merge seam. Committed snapshots survive.
      await reapArtifactsForSessionClose(sessionId);

      // Auto-resolve any open dynamic-workflow review items for this session —
      // the merge IS the human's close-out action. Fire-and-forget: a resolve
      // failure must never fail the merge itself.
      void DynamicWorkflowTracker.tryGetInstance()
        ?.resolveReviewItemsForSession(sessionId, 'user')
        .catch((err: unknown) => {
          console.warn(`[IPC:git] Failed to auto-resolve dynamic-workflow review items for session ${sessionId}:`, err);
        });

      // End a quick session's live process (either substrate) — the merge
      // closes out the session's work (see endLiveSessionProcesses).
      endLiveSessionProcesses(session, sessionId);

      // Update git status for ALL sessions in the project since main was updated
      // Wait for this to complete before returning so UI sees the updated status immediately
      if (session.projectId !== undefined) {
        try {
          await gitStatusManager.updateProjectGitStatusAfterMainUpdate(session.projectId, sessionId);
        } catch (error) {
          console.error(`[IPC:git] Failed to update git status for project ${session.projectId}:`, error);
          // Continue even if status update fails - the merge succeeded
        }
      }

      return { success: true, data: { message: `Successfully squashed and merged worktree to ${mainBranch}` } };
    } catch (error: unknown) {
      console.error(`[IPC:git] Failed to squash and merge worktree to main for session ${sessionId}:`, error);

      // Emit git operation failed event
      const errorMessage = `✗ Merge failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (error && typeof error === 'object' && 'gitOutput' in error && (error as GitError).gitOutput ? `\n\nGit output:\n${(error as GitError).gitOutput}` : '');

      // Don't let this block the error response either
      try {
        emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
          operation: 'squash_and_merge',
          error: error instanceof Error ? error.message : String(error),
          gitOutput: error && typeof error === 'object' && 'gitOutput' in error ? (error as GitError).gitOutput : undefined
        });
      } catch (outputError) {
        console.error(`[IPC:git] Failed to emit git error event for session ${sessionId}:`, outputError);
      }

      // Pass detailed git error information to frontend
      const gitError = error as GitError;
      return {
        success: false,
        // The branch had nothing left to give main — almost always because the
        // work was already landed by hand (the agent merged it in chat). That is
        // not a failure, so the dialog offers Mark complete instead of an error.
        alreadyUpToDate: isAlreadyUpToDate(error),
        error: error instanceof Error ? error.message : 'Failed to squash and merge worktree to main',
        gitError: {
          commands: gitError.gitCommands,
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory,
          projectPath: gitError.projectPath,
          originalError: gitError.originalError?.message
        }
      };
    }
  };

  const rebaseToMain = async ({ sessionId }: OpsInput<'rebaseToMain'>): Promise<OpsResult<'rebaseToMain'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the project to find the main branch and project path
      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      // Get the effective main branch (override or auto-detected)
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path);

      // Pre-merge guard: if main has advanced past this branch, a rebase is
      // needed first. We do NOT auto-rebase here — mergeWorktreeToMain would
      // silently rebase the worktree onto main (surprising the operator with
      // extra commits in the merge / PR). Block and report so the user can
      // rebase via chat, then merge.
      if (await worktreeManager.hasChangesToRebase(session.worktreePath, mainBranch)) {
        return {
          success: false,
          needsRebase: true,
          error: `${mainBranch} has new commits since this branch started. Rebase this worktree onto ${mainBranch} before merging — you can ask the agent to do it in chat.`,
        };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nMerging to ${mainBranch} (preserving all commits)...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'merge_to_main',
        mainBranch
      });

      await worktreeManager.mergeWorktreeToMain(project.path, session.worktreePath, mainBranch);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully merged worktree to ${mainBranch}`;
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'merge_to_main',
        mainBranch
      });
      sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: successMessage,
        timestamp: new Date()
      });

      // Sprint close-out (feat/parallel-sprint): integrated lanes → done stage,
      // batch → completed, outcome='merged' stamped. Fail-soft — never affects
      // the merge result. (finalizeSprintLanesOnSessionMerge is folded into
      // stampMergedOutcomeForSession -> closeOutSessionAfterLanding, TASK-296.)
      await stampMergedOutcomeForSession(sessionId, project?.path);

      // Reap UNCOMMITTED run artifacts for every run this session hosted (IDEA-039).
      // Session-hosted runs can't close out via runs.merge (assertNotSessionHosted),
      // so their reap happens at this session merge seam. Committed snapshots survive.
      await reapArtifactsForSessionClose(sessionId);

      // Auto-resolve any open dynamic-workflow review items for this session —
      // the merge IS the human's close-out action. Fire-and-forget: a resolve
      // failure must never fail the merge itself.
      void DynamicWorkflowTracker.tryGetInstance()
        ?.resolveReviewItemsForSession(sessionId, 'user')
        .catch((err: unknown) => {
          console.warn(`[IPC:git] Failed to auto-resolve dynamic-workflow review items for session ${sessionId}:`, err);
        });

      // End a quick session's live process (either substrate) — the merge
      // closes out the session's work (see endLiveSessionProcesses).
      endLiveSessionProcesses(session, sessionId);

      // Update git status for ALL sessions in the project since main was updated
      // Wait for this to complete before returning so UI sees the updated status immediately
      if (session.projectId !== undefined) {
        try {
          await gitStatusManager.updateProjectGitStatusAfterMainUpdate(session.projectId, sessionId);
        } catch (error) {
          console.error(`[IPC:git] Failed to update git status for project ${session.projectId}:`, error);
          // Continue even if status update fails - the merge succeeded
        }
      }

      return { success: true, data: { message: `Successfully merged worktree to ${mainBranch}` } };
    } catch (error: unknown) {
      console.error('Failed to merge worktree to main:', error);

      const gitError = error as GitError;

      // Add error message to session output
      const errorMessage = `✗ Merge failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      sessionManager.addSessionOutput(sessionId, {
        type: 'stderr',
        data: errorMessage,
        timestamp: new Date()
      });
      // Pass detailed git error information to frontend
      return {
        success: false,
        // See the squash handler: an already-landed branch is a Mark-complete
        // prompt, not a merge failure.
        alreadyUpToDate: isAlreadyUpToDate(error),
        error: error instanceof Error ? error.message : 'Failed to merge worktree to main',
        gitError: {
          commands: gitError.gitCommands,
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory,
          projectPath: gitError.projectPath,
          originalError: gitError.originalError?.message
        }
      };
    }
  };

  // Git pull/push operations for main repo sessions
  const pull = async ({ sessionId }: OpsInput<'pull'>): Promise<OpsResult<'pull'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nPulling latest changes from remote...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'pull'
      });

      // Run git pull
      const result = await worktreeManager.gitPull(session.worktreePath);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully pulled latest changes` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'pull',
        output: result.output
      });

      // Check if this is a main repo session pulling main branch updates
      if (session.isMainRepo && session.projectId !== undefined) {
        // If pulling to main repo, all worktrees might be affected
        await refreshGitStatusForProject(session.projectId);
      } else {
        // If pulling to a worktree, only this session is affected
        await refreshGitStatusForSession(sessionId);
      }

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to pull from remote:', error);

      // Emit git operation failed event
      const gitError = error as GitError;
      
      const errorMessage = `✗ Pull failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'pull',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput
      });

      // Check if it's a merge conflict
      if ((error instanceof Error && error.message?.includes('CONFLICT')) || (gitError.gitOutput?.includes('CONFLICT'))) {
        return {
          success: false,
          error: 'Merge conflicts detected. Please resolve conflicts manually or ask Claude to help.',
          isMergeConflict: true,
          gitError: {
            output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
            workingDirectory: gitError.workingDirectory || ''
          }
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to pull from remote',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  };

  const push = async ({ sessionId }: OpsInput<'push'>): Promise<OpsResult<'push'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Emit git operation started event to all sessions in project
      const startMessage = `🔄 GIT OPERATION\nPushing changes to remote...`;
      emitGitOperationToProject(sessionId, 'git:operation_started', startMessage, {
        operation: 'push'
      });

      // Run git push
      const result = await worktreeManager.gitPush(session.worktreePath);

      // Emit git operation completed event to all sessions in project
      const successMessage = `✓ Successfully pushed changes to remote` +
                            (result.output ? `\n\nGit output:\n${result.output}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_completed', successMessage, {
        operation: 'push',
        output: result.output
      });
      sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: successMessage,
        timestamp: new Date()
      });

      // Create-PR close-out (mirrors the session-merge close-out, outcome='pr_open'):
      // a successful push delivers the session's artifact to origin, so its runs are
      // a SUCCESS — not a dismiss. The Create-PR dialog follows this push with a
      // `sessions:delete`; that dismiss path's `cancelHostedRuns` would otherwise
      // stamp the still-running run `status='canceled', outcome='canceled'` (the bug
      // where a successful Create-PR showed CANCELED). Completing the run HERE — to
      // the same `completed`/`pr_open` terminal the run-scoped `runs.createPr`
      // records — makes that later cancel a no-op (it only touches non-terminal
      // runs). Sprint lanes are finalized exactly as the merge close-out does.
      // Fail-soft: this bookkeeping must never fail the push response.
      try {
        await finalizeSprintLanesOnSessionMerge(databaseService, sessionId);
        const closed = stampSessionRunsPrOpen(makeDatabaseLike(databaseService), sessionId);
        if (closed > 0) {
          console.log(`[IPC:git] Create-PR close-out: marked ${closed} run(s) completed/pr_open for session ${sessionId}`);
        }
        // Migration 066: finalizeSprintLanesOnSessionMerge ran its recompute while
        // the runs were STILL non-terminal (arm 2 held tasks at 'In development');
        // stampSessionRunsPrOpen just flipped them terminal (status='completed',
        // outcome='pr_open'). Re-derive now they are terminal so non-integrated
        // batch lanes AND direct task-linked runs revert off 'In development' to
        // their entry stage (pr_open ≠ merged). The terminal-stage guard protects
        // the just-Done integrated tasks. Without this the later sessions:delete
        // dismiss cannot heal them (cancelHostedRuns selects only non-terminal runs
        // → zero rows). Fail-soft.
        await recomputeSessionRunTaskStages(databaseService, sessionId);
        // Reap UNCOMMITTED run artifacts for every run this session hosted
        // (IDEA-039) — create-PR is a delivering close-out, same as merge.
        // Committed snapshots survive.
        await reapArtifactsForSessionClose(sessionId);
        trackUsage('session_resolved', { action: 'pr' });
      } catch (closeoutError) {
        console.error(`[IPC:git] Create-PR close-out failed for session ${sessionId} (push unaffected):`, closeoutError);
      }

      // Check if this is a main repo session pushing to main branch
      if (session.isMainRepo && session.projectId !== undefined) {
        // If pushing from main repo, all worktrees might be affected
        await refreshGitStatusForProject(session.projectId);
      } else {
        // If pushing from a worktree, only this session is affected
        await refreshGitStatusForSession(sessionId);
      }

      return { success: true, data: result };
    } catch (error: unknown) {
      console.error('Failed to push to remote:', error);

      const gitError = error as GitError;
      
      // Emit git operation failed event
      const errorMessage = `✗ Push failed: ${error instanceof Error ? error.message : 'Unknown error'}` +
                          (gitError.gitOutput ? `\n\nGit output:\n${gitError.gitOutput}` : '');
      emitGitOperationToProject(sessionId, 'git:operation_failed', errorMessage, {
        operation: 'push',
        error: error instanceof Error ? error.message : String(error),
        gitOutput: gitError.gitOutput
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to push to remote',
        gitError: {
          output: gitError.gitOutput || (error instanceof Error ? error.message : String(error)),
          workingDirectory: gitError.workingDirectory || ''
        }
      };
    }
  };

  /**
   * Whether this session's work has been DELIVERED, answered from three sides:
   *
   *   delivered      — a run this session hosted carries a
   *                     DELIVERED_RUN_OUTCOMES stamp (our own merge /
   *                     create-PR path ran).
   *   landed         — git says the branch has nothing left to give main
   *                     (WorktreeManager.getBranchLandingState), which is how
   *                     the "the agent merged it in chat" case is visible at
   *                     all.
   *   completedNoCode — the session hosted a COMPLETED run of a workflow that
   *                     never touches the repo (Planner / Launch — see
   *                     sessionCompletedNoCodeWork) and the worktree has zero
   *                     own commits. Such a run's "delivery" is the backlog
   *                     rows it wrote via the MCP tools, so delivered/landed
   *                     never fire for it even though the run genuinely
   *                     finished — without this signal it is indistinguishable
   *                     from a session nobody ever touched.
   *
   * Read by the dismiss dialog: any of the three turns Dismiss into a choice
   * between Mark complete and dismissing anyway, because dismissing a session
   * whose work already landed (in the tree OR the backlog) also throws away
   * findings that still apply. Fail-soft on every axis — an unreadable
   * worktree reports landed=false and the operator simply gets the plain
   * confirmation.
   */
  const getDeliveryState = async ({ sessionId }: OpsInput<'getDeliveryState'>): Promise<OpsResult<'getDeliveryState'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      const delivered = sessionDeliveredWork(makeDatabaseLike(databaseService), sessionId);

      let landed = false;
      let ownCommits = 0;
      // Whether `ownCommits` is a PROVEN count (the git probe ran and
      // succeeded) rather than the fail-soft default. `completedNoCode` claims
      // the run finished with NO repository changes, so it may only fire on a
      // proven zero — an unreadable worktree, a missing project, or a session
      // with no worktree path at all falls back to the plain confirmation, as
      // documented above.
      let ownCommitsProven = false;
      const project = sessionManager.getProjectForSession(sessionId);
      if (session.worktreePath && project) {
        try {
          const mainBranch = await worktreeManager.getProjectMainBranch(project.path);
          const state = await worktreeManager.getBranchLandingState(session.worktreePath, mainBranch);
          landed = state.landed;
          ownCommits = state.ownCommits;
          ownCommitsProven = true;
        } catch (error) {
          console.error(`[IPC:git] landing probe failed for session ${sessionId}:`, error);
        }
      }

      // Only meaningful when the worktree PROVABLY has no own commits —
      // ownCommits > 0 means git already has a real answer via landed/delivered,
      // and an unproven 0 (probe failed / never ran) must not read as "no code".
      const completedNoCode = ownCommitsProven
        && ownCommits === 0
        && sessionCompletedNoCodeWork(makeDatabaseLike(databaseService), sessionId);

      // TASK-296: how many integrated sprint-lane tasks Mark-complete would
      // move to Done — only meaningful (and only computed) when `landed`,
      // since that is the ONLY condition under which markComplete's re-probe
      // takes the close-out branch at all.
      const integratedLaneCount = landed ? countIntegratedLaneTasksNotYetDone(databaseService, sessionId) : 0;

      return { success: true, data: { delivered, landed, ownCommits, completedNoCode, integratedLaneCount } };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read session delivery state',
      };
    }
  };

  /**
   * Record that this session's work LANDED by a path we never observed — the
   * agent merged it in chat, or the branch was merged/rebased outside the app.
   *
   * TASK-296: re-probes delivery state SERVER-SIDE (the same
   * WorktreeManager.getBranchLandingState probe getDeliveryState uses — never
   * trusts a client-supplied flag, since time may have passed since the
   * dismiss dialog last asked) and branches on what it finds:
   *
   *   - `landed`: the branch is ALREADY an ancestor of / diffless against
   *     main. Runs the exact same close-out an in-app squash/rebase merge
   *     performs — {@link closeOutSessionAfterLanding} — with outcome='merged'
   *     and `merge_sha` = main's own current tip (there is no merge commit WE
   *     made; main's tip IS where this session's code already lives).
   *     Integrated sprint lanes move to Done, the batch goes terminal, and the
   *     runs are stamped 'merged'.
   *   - otherwise: the pre-existing bookkeeping stamp — outcome='completed'
   *     via stampSessionRunsCompleted (reusing its "not already delivered"
   *     guard so a run that recorded a more specific outcome is never
   *     clobbered). No git touched, no lane close-out — the branch's work is
   *     not actually on main, so moving tasks to Done would be a lie. If the
   *     session has real own commits not on main (not the DB-only
   *     completedNoCode case), the response's `laneTasksLeftOpen` reports how
   *     many integrated-lane tasks were left at their pre-close-out stage, so
   *     the caller/dialog can surface it instead of silently stranding them.
   *
   * The caller archives the session afterwards through the normal delete
   * path, and because delivery is now stamped, that archive keeps the
   * session's findings instead of sweeping them.
   */
  const markComplete = async ({ sessionId }: OpsInput<'markComplete'>): Promise<OpsResult<'markComplete'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Re-probe delivery state SERVER-SIDE — mirrors getDeliveryState's own
      // probe (never trust a client-supplied flag).
      let landed = false;
      let ownCommits = 0;
      let ownCommitsProven = false;
      let mainBranch: string | undefined;
      const project = sessionManager.getProjectForSession(sessionId);
      if (session.worktreePath && project) {
        try {
          mainBranch = await worktreeManager.getProjectMainBranch(project.path);
          const state = await worktreeManager.getBranchLandingState(session.worktreePath, mainBranch);
          landed = state.landed;
          ownCommits = state.ownCommits;
          ownCommitsProven = true;
        } catch (error) {
          console.error(`[IPC:git] markComplete landing probe failed for session ${sessionId}:`, error);
        }
      }

      if (landed && session.worktreePath && mainBranch) {
        // The branch was merged/rebased into main OUTSIDE the app — run the
        // SAME close-out an in-app merge performs. mergeSha = main's own
        // current tip in THIS worktree (a plain ref read; no mutation).
        let mergeSha: string | undefined;
        try {
          mergeSha = (await runGitAsync(session.worktreePath, ['rev-parse', mainBranch])).trim();
        } catch (error) {
          console.error(`[IPC:git] Failed to resolve ${mainBranch} HEAD for session ${sessionId}:`, error);
        }
        // Counted BEFORE the close-out runs (finalizeSprintLanesOnSessionMerge
        // is idempotent and would read 0 afterward) so the response can report
        // how many integrated-lane tasks it is ABOUT to move to Done.
        const tasksMovedToDone = countIntegratedLaneTasksNotYetDone(databaseService, sessionId);
        const { stampedRuns } = await closeOutSessionAfterLanding(databaseService, sessionId, { mergeSha });
        console.log(
          `[IPC:git] Mark complete: session ${sessionId}'s branch already landed on ${mainBranch} — ran the full close-out (stamped ${stampedRuns} run(s) outcome='merged', moved ${tasksMovedToDone} task(s) to Done)`,
        );
        trackUsage('session_resolved', { action: 'complete' });
        return { success: true, data: { stamped: stampedRuns, tasksMovedToDone } };
      }

      const stamped = stampSessionRunsCompleted(makeDatabaseLike(databaseService), sessionId);
      console.log(`[IPC:git] Marked session ${sessionId} complete (stamped ${stamped} run(s))`);
      trackUsage('session_resolved', { action: 'complete' });

      // ownCommits > 0 (a real branch not on main — NOT the DB-only
      // completedNoCode case) may be sitting on a sprint batch this stamp just
      // left untouched. Report how many integrated-lane tasks so the
      // caller/dialog can say so instead of silently stranding them.
      const laneTasksLeftOpen = ownCommitsProven && ownCommits > 0
        ? countIntegratedLaneTasksNotYetDone(databaseService, sessionId)
        : 0;
      if (laneTasksLeftOpen > 0) {
        return { success: true, data: { stamped, laneTasksLeftOpen } };
      }
      return { success: true, data: { stamped } };
    } catch (error: unknown) {
      console.error(`[IPC:git] Failed to mark session ${sessionId} complete:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to mark session complete',
      };
    }
  };

  /**
   * Subjects of the session branch's OWN commits (mainBranch..HEAD in the
   * worktree), newest first. Used by the merge dialog to prefill the squash
   * commit message — unlike sessions:get-last-commits this never includes
   * main-branch history.
   */
  const getBranchCommitSubjects = async ({ sessionId }: OpsInput<'getBranchCommitSubjects'>): Promise<OpsResult<'getBranchCommitSubjects'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const mainBranch = await worktreeManager.getProjectMainBranch(project.path);
      const output = runGit(session.worktreePath, [
        'log', '--pretty=%s', END_OF_OPTIONS, `${mainBranch}..HEAD`,
      ]).trim();
      const subjects = output.length > 0 ? output.split('\n') : [];
      return { success: true, data: { subjects } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read branch commits' };
    }
  };

  const getLastCommits = async ({ sessionId, count = 50 }: OpsInput<'getLastCommits'>): Promise<OpsResult<'getLastCommits'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      if (!session.worktreePath) {
        return { success: false, error: 'Session has no worktree path' };
      }

      // Get the last N commits from the repository
      const commits = await worktreeManager.getLastCommits(session.worktreePath, count);
      const limitReached = commits.length === count;

      // Transform commits to match ExecutionDiff format
      const executionDiffs = commits.map((commit, index) => ({
        id: index + 1,
        session_id: sessionId,
        commit_message: commit.message,
        execution_sequence: index + 1,
        stats_additions: commit.additions || 0,
        stats_deletions: commit.deletions || 0,
        stats_files_changed: commit.filesChanged || 0,
        commit_hash: commit.hash,
        timestamp: commit.date,
        author: commit.author || 'Unknown',
        history_limit_reached: limitReached
      }));

      return { success: true, data: executionDiffs };
    } catch (error: unknown) {
      console.error('Failed to get last commits:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get last commits'
      };
    }
  };

  // Git operation helpers
  const hasChangesToRebase = async ({ sessionId }: OpsInput<'hasChangesToRebase'>): Promise<OpsResult<'hasChangesToRebase'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      // Get the effective main branch (override or auto-detected)
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path);
      const hasChanges = await worktreeManager.hasChangesToRebase(session.worktreePath, mainBranch);

      return { success: true, data: hasChanges };
    } catch (error) {
      console.error('Failed to check for changes to rebase:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check for changes to rebase' };
    }
  };

  const getGitCommands = async ({ sessionId }: OpsInput<'getGitCommands'>): Promise<OpsResult<'getGitCommands'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }
      
      // Check if session is archived - worktree won't exist
      if (session.archived) {
        return { success: false, error: 'Cannot access git commands for archived session' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      // Get the effective main branch (override or auto-detected)
      const mainBranch = await worktreeManager.getProjectMainBranch(project.path);

      // Get current branch name
      const currentBranch = runGit(session.worktreePath, ['branch', '--show-current']).trim();

      const originBranch = session.isMainRepo
        ? await worktreeManager.getOriginBranch(session.worktreePath, mainBranch)
        : null;

      const rebaseCommands = worktreeManager.generateRebaseCommands(mainBranch);
      const squashCommands = worktreeManager.generateSquashCommands(mainBranch, currentBranch);
      const mergeCommands = worktreeManager.generateMergeCommands(mainBranch, currentBranch);

      return {
        success: true,
        data: {
          rebaseCommands,
          squashCommands,
          mergeCommands,
          mainBranch,
          originBranch: originBranch || undefined,
          currentBranch
        }
      };
    } catch (error) {
      // Don't log errors for expected failures
      const errorMessage = error instanceof Error ? error.message : 'Failed to get git commands';
      if (!errorMessage.includes('archived session')) {
        console.error('Failed to get git commands:', error);
      }
      return { success: false, error: errorMessage };
    }
  };

  /**
   * `git rev-list --count HEAD..<sha>` — how many commits `sha` has that HEAD
   * lacks. `sha` must be a RESOLVED commit sha from resolveSessionDiffBaseRef
   * (never a raw branch/ref name — resolving first pins the count to the
   * same commit the response labels, and removes the verify-then-use window
   * in which a ref could move or vanish). The `HEAD..` prefix additionally
   * makes it structurally impossible for the argv token to start with `-`.
   *
   * Returns `null` — never a fabricated `0` — when git cannot answer (an
   * unborn HEAD, a sha that no longer resolves, unparsable output): the
   * per-leg contract in SessionGitOpsLike.getComparisonBases is that an
   * unanswerable leg is `null`, and a confident `behind: 0` is the opposite
   * of that.
   */
  async function countBehind(worktreePath: string, sha: string): Promise<number | null> {
    try {
      const out = await runGitAsync(worktreePath, ['rev-list', '--count', END_OF_OPTIONS, `HEAD..${sha}`]);
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Read-only freshness signal for `originDefault`: the mtime of the
   * worktree's `FETCH_HEAD` file, resolved via `git rev-parse --git-path` (not
   * a hardcoded `.git/FETCH_HEAD`, since a worktree's gitdir is elsewhere).
   * NEVER triggers a fetch — a missing/unreadable file just answers `null`.
   */
  async function getFetchedAt(worktreePath: string): Promise<string | null> {
    try {
      const gitPath = (await runGitAsync(worktreePath, ['rev-parse', '--git-path', 'FETCH_HEAD'])).trim();
      const resolved = path.isAbsolute(gitPath) ? gitPath : path.join(worktreePath, gitPath);
      const stat = await fs.promises.stat(resolved);
      return stat.mtime.toISOString();
    } catch {
      return null;
    }
  }

  /**
   * Live "worktree changed" feed for the rail's Diff tab — see
   * {@link SessionGitOpsLike.subscribeWorktreeChanges} and
   * WorktreeChangeNotifier. One notifier per ops bag (one per app); it holds
   * no watcher until the first subscriber arrives.
   */
  const worktreeChangeNotifier = new WorktreeChangeNotifier();
  const subscribeWorktreeChanges = async (
    { sessionId }: OpsInput<'subscribeWorktreeChanges'>,
    listener: () => void,
  ): Promise<OpsResult<'subscribeWorktreeChanges'>> => {
    const session = await sessionManager.getSession(sessionId);
    if (!session || !session.worktreePath) {
      return { success: false, error: 'Session or worktree path not found' };
    }
    const unsubscribe = worktreeChangeNotifier.subscribe(sessionId, session.worktreePath, listener);
    return { success: true, unsubscribe };
  };

  /**
   * Backs the future BaseSelector menu (TASK-216): every candidate base the
   * picker can offer, resolved server-side so the renderer never runs git
   * itself. See {@link SessionGitOpsLike.getComparisonBases} for the per-leg
   * degradation contract.
   */
  const getComparisonBases = async ({
    sessionId,
  }: OpsInput<'getComparisonBases'>): Promise<OpsResult<'getComparisonBases'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const project = sessionManager.getProjectForSession(sessionId);
      if (!project) {
        return { success: false, error: 'Project not found for session' };
      }

      const worktreePath = session.worktreePath;

      // branchPoint: the session's recorded branch point, if it still resolves.
      const branchPointSha = await resolveSessionDiffBaseRef(worktreePath, [session.baseCommit]);
      const branchPoint = branchPointSha ? { ref: branchPointSha, shortSha: branchPointSha.slice(0, 7) } : null;

      // defaultBranch: origin/HEAD's symref first, falling back to the
      // project's checked-out branch. getProjectMainBranch throws on detached
      // HEAD — caught here so this method never propagates that throw.
      let defaultBranch: string | null = null;
      try {
        const symref = (
          await runGitAsync(worktreePath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
        ).trim();
        defaultBranch = symref.startsWith('origin/') ? symref.slice('origin/'.length) : symref || null;
      } catch {
        try {
          defaultBranch = await worktreeManager.getProjectMainBranch(project.path);
        } catch {
          defaultBranch = null;
        }
      }

      let localDefault: { ref: string; behind: number } | null = null;
      let originDefault: { ref: string; behind: number; fetchedAt: string | null } | null = null;

      if (defaultBranch) {
        // Both legs: resolve the DERIVED ref name to a sha first (option-like
        // guard + `rev-parse --verify --end-of-options`, the TASK-208
        // discipline), feed only that sha to the behind query, and keep the
        // human-readable name solely as the response label. A leg whose ref
        // does not resolve, or whose count git cannot answer, is `null`.
        const localSha = await resolveSessionDiffBaseRef(worktreePath, [defaultBranch]);
        if (localSha) {
          const behind = await countBehind(worktreePath, localSha);
          localDefault = behind === null ? null : { ref: defaultBranch, behind };
        }

        const originRef = await worktreeManager.getOriginBranch(worktreePath, defaultBranch);
        const originSha = originRef ? await resolveSessionDiffBaseRef(worktreePath, [originRef]) : null;
        if (originRef && originSha) {
          const behind = await countBehind(worktreePath, originSha);
          originDefault =
            behind === null
              ? null
              : { ref: originRef, behind, fetchedAt: await getFetchedAt(worktreePath) };
        }
      }

      return {
        success: true,
        data: { branchPoint, defaultBranch, localDefault, originDefault },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get comparison bases',
      };
    }
  };

  const getCurrentBranch = async ({ sessionId }: OpsInput<'getCurrentBranch'>): Promise<OpsResult<'getCurrentBranch'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }
      // An archived session's worktree is gone; readCurrentBranch would only log
      // a missing-directory warning per hover, so short-circuit to null.
      if (session.archived) {
        return { success: true, data: { branch: null } };
      }
      // Every git read walks UP to the nearest enclosing repo. A session whose
      // worktree was removed or never finished being created leaves a husk
      // directory INSIDE the project checkout, so an unguarded branch read
      // there answers with the PROJECT's branch ("main") — a confident wrong
      // answer, not an error. Trust the branch only when the repo root git
      // resolves IS this session's own path; realpath both sides so a symlinked
      // checkout (/tmp -> /private/tmp) does not read as a mismatch. An in-place
      // session passes this by construction: its worktreePath IS the checkout,
      // so it legitimately reports the project's branch.
      if (!isOwnRepoRoot(session.worktreePath)) {
        return { success: true, data: { branch: null } };
      }
      return { success: true, data: { branch: readCurrentBranch(session.worktreePath) } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get current branch' };
    }
  };

  const getRemoteUrl = async ({ sessionId }: OpsInput<'getRemoteUrl'>): Promise<OpsResult<'getRemoteUrl'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      const remoteUrl = runGit(session.worktreePath, ['remote', 'get-url', 'origin']).trim();

      const branchName = runGit(session.worktreePath, ['branch', '--show-current']).trim();

      return { success: true, data: { remoteUrl, branchName } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get remote URL' };
    }
  };

  const getGitStatus = async ({ sessionId, nonBlocking, isInitialLoad }: OpsInput<'getGitStatus'>): Promise<OpsResult<'getGitStatus'>> => {
    try {
      const session = await sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return { success: false, error: 'Session or worktree path not found' };
      }

      if (session.archived) {
        return { success: false, error: 'Cannot get git status for archived session' };
      }

      // For initial loads, use the queued approach to prevent UI lock
      if (isInitialLoad) {
        const cachedStatus = await gitStatusManager.queueInitialLoad(sessionId);
        return { 
          success: true, 
          gitStatus: cachedStatus,
          backgroundRefresh: true 
        };
      }

      // If nonBlocking is true, start refresh in background and return immediately
      if (nonBlocking) {
        // Start the refresh in background
        setImmediate(() => {
          gitStatusManager.refreshSessionGitStatus(sessionId, true).catch(error => {
            console.error(`[Git] Background git status refresh failed for session ${sessionId}:`, error);
          });
        });
        
        // Return the cached status if available, or indicate background refresh started
        const cachedStatus = await gitStatusManager.getGitStatus(sessionId);
        return { 
          success: true, 
          gitStatus: cachedStatus,
          backgroundRefresh: true 
        };
      } else {
        // Use refreshSessionGitStatus with user-initiated flag
        // This is called when user clicks on a session, so show loading state
        const gitStatus = await gitStatusManager.refreshSessionGitStatus(sessionId, true);
        return { success: true, gitStatus };
      }
    } catch (error) {
      console.error('Error getting git status:', error);
      return { success: false, error: (error as Error).message };
    }
  };

  const cancelStatusForProject = async ({ projectId }: OpsInput<'cancelStatusForProject'>): Promise<OpsResult<'cancelStatusForProject'>> => {
    try {
      // Get all sessions for the project
      const sessions = await sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectId && !s.archived);
      
      // Cancel git status operations for all project sessions
      const sessionIds = projectSessions.map(s => s.id);
      gitStatusManager.cancelMultipleGitStatus(sessionIds);
      
      return { success: true };
    } catch (error) {
      console.error('Error cancelling git status:', error);
      return { success: false, error: (error as Error).message };
    }
  };

  return {
    getExecutions,
    getExecutionDiff,
    commit,
    diff,
    getCombinedDiff,
    rebaseMainIntoWorktree,
    abortRebaseAndUseClaude,
    squashAndRebaseToMain,
    rebaseToMain,
    pull,
    push,
    getDeliveryState,
    markComplete,
    getBranchCommitSubjects,
    getLastCommits,
    hasChangesToRebase,
    getGitCommands,
    getCurrentBranch,
    getRemoteUrl,
    getGitStatus,
    cancelStatusForProject,
    getComparisonBases,
    subscribeWorktreeChanges,
  };
}
