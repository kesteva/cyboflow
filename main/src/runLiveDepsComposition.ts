/**
 * runLiveDepsComposition — the live-run tRPC dep wiring, extracted from
 * index.ts's app.whenReady() block (GitHub issue #19, the god-file split,
 * step 23). It wires, in this order: runs.nudge (+ its awaitTurnStart waiter)
 * and the runs.sessionSettleState barrier, the approve-ideas verdict-delivery
 * nudge, runs.queueInput, runs.interruptAndSend, the live-input relay
 * (relayInput / relayResize / endSession / killSession / getPtyBacklog), the
 * run user-shell (RunShellManager + setRunShellDeps), and the run close-out
 * (merge / createPr / dismiss) deps. The body is index.ts's verbatim, apart
 * from:
 *
 * - `runShellManager` (index.ts's module holder, also read by drainOnQuit) is
 *   a local assigned by the SAME verbatim statement, then RETURNED and
 *   assigned at the call site. The setRunShellDeps closures read the local; the
 *   module holder is never reassigned after this runs, so both always name the
 *   same instance — identical to the original lazy holder read.
 * - One GETTER: `getMainWindow` → index.ts's `mainWindow`, read inside the
 *   shell-output callback at call time. It MUST be lazy: this runs before
 *   createWindow() assigns the window, and createWindow() reassigns it (and
 *   the 'closed' handler nulls it) over the app's life.
 *
 * Passed by value (each assigned exactly once in initializeServices(), which
 * app.whenReady() awaits before this runs, and never reassigned): runQueues,
 * runExecutor, substrateFacade, worktreeManager, sessionManager; db and
 * loggerLike are whenReady-local consts and prototypeServerReaper is a module
 * const.
 *
 * A SIBLING of index.ts on purpose — composition-root code that reaches for
 * router singletons and concrete services, so it must stay OUT of
 * main/src/orchestrator/** (the standalone-typecheck invariant scans that
 * tree). No unit test, as there was none over the inline block; the run
 * handlers and RunShellManager carry their own suites.
 */

import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { BrowserWindow } from 'electron';
import { ApprovalRouter } from './orchestrator/approvalRouter';
import { TaskChangeRouter } from './orchestrator/taskChangeRouter';
import { MonitorRegistry } from './orchestrator/programmatic/monitor';
import { VerificationScheduler } from './orchestrator/verify/verificationScheduler';
import { nudgeRunHandler } from './orchestrator/nudgeRunHandler';
import {
  setNudgeRunDeps,
  setSessionSettleDeps,
  setQueueInputDeps,
  setInterruptAndSendDeps,
  setRelayDeps,
  setRunShellDeps,
  setRunCloseoutDeps,
} from './orchestrator/trpc/routers/runs';
import { setResolveVerdictNudgeDeps } from './orchestrator/trpc/routers/reviewItems';
import { RunShellManager } from './services/runShellManager';
import { getCyboflowSubdirectory } from './utils/cyboflowDirectory';
import type { PrototypeServerReaper } from './services/prototypeServerReaper';
import type { RunQueueRegistry } from './orchestrator/RunQueueRegistry';
import type { RunExecutor } from './orchestrator/runExecutor';
import type { SubstrateDispatchFacade } from './services/substrateDispatchFacade';
import type { WorktreeManager } from './services/worktreeManager';
import type { SessionManager } from './services/sessionManager';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

export interface RunLiveDepsCompositionDeps {
  db: DatabaseLike;
  loggerLike: LoggerLike;
  runQueues: RunQueueRegistry;
  runExecutor: RunExecutor;
  substrateFacade: SubstrateDispatchFacade;
  worktreeManager: WorktreeManager;
  sessionManager: SessionManager;
  prototypeServerReaper: PrototypeServerReaper;
  /** index.ts's live `mainWindow` binding — null until createWindow(), reassigned per window. */
  getMainWindow: () => BrowserWindow | null;
}

export interface RunLiveDepsComposition {
  /** index.ts's runShellManager holder (drainOnQuit destroys every run shell). */
  runShellManager: RunShellManager | null;
}

export function composeRunLiveDeps(deps: RunLiveDepsCompositionDeps): RunLiveDepsComposition {
  const {
    db,
    loggerLike,
    runQueues,
    runExecutor,
    substrateFacade,
    worktreeManager,
    sessionManager,
    prototypeServerReaper,
    getMainWindow,
  } = deps;

  // Assigned by the run user-shell block below, then returned (see header).
  let runShellManager: RunShellManager | null = null;

  // Piece C — idle-chat nudge. Uses the SAME `db` DatabaseLike adapter +
  // `runQueues` + `loggerLike` as the cancelAndRestart wiring above, plus the
  // module-scoped RunExecutor built in initializeServices(). The handler
  // re-drives runExecutor.execute(runId) with a stashed nudge so the run
  // resumes its SDK conversation.
  //
  // awaitTurnStart: one-shot waiter over the facade's per-logical-turn
  // 'spawned' fan-in (panelId === runId for flow runs). Only consumed by
  // callers opting into `deliveredAt: 'turn-start'` (the gate-resolution
  // paths: approve-ideas verdicts, recovery-gate answers) — the plain
  // runs.nudge mutation keeps its await-the-drain behavior.
  const nudgeDeps = {
    db,
    runQueues,
    runExecutor,
    logger: loggerLike,
    awaitTurnStart: (runId: string) => {
      let onSpawned: ((payload: unknown) => void) | null = null;
      const started = new Promise<void>((resolveStarted) => {
        onSpawned = (payload: unknown) => {
          const evt = payload as { panelId?: unknown };
          if (evt !== null && typeof evt === 'object' && evt.panelId === runId) {
            if (onSpawned) substrateFacade.off('spawned', onSpawned);
            resolveStarted();
          }
        };
        substrateFacade.on('spawned', onSpawned);
      });
      return {
        started,
        cancel: () => {
          if (onSpawned) substrateFacade.off('spawned', onSpawned);
        },
      };
    },
  };
  setNudgeRunDeps(nudgeDeps);
  // Live merge/PR gate (runs.sessionSettleState): the chatTurnInFlight half
  // answers from the SAME facade barrier the experiment settle guard uses.
  setSessionSettleDeps({
    hasActiveAgentTurn: (sessionId) => substrateFacade.hasTurnInFlightForSession(sessionId),
  });
  console.log('[Main] runs.nudge deps wired');

  // Approve-ideas verdict delivery (IDEA-009 / TASK-035B): the default
  // ORCHESTRATED planner parks its SDK conversation at a drained REST after
  // minting the approve-ideas gate via cyboflow_report_finding, so a submitted
  // per-idea verdict map must be DELIVERED as the run's next turn (it cannot read
  // review items via MCP). Wrap nudgeRunHandler with the SAME deps bag the nudge
  // mutation uses so the resume re-drives the same warm executor; reviewItems.
  // resolve nudges FIRST and resolves once the resumed turn STARTS (the caller
  // passes `deliveredAt: 'turn-start'`, backed by awaitTurnStart above).
  setResolveVerdictNudgeDeps({
    nudge: (runId, text, opts) => nudgeRunHandler(runId, text, nudgeDeps, opts),
  });
  console.log('[Main] reviewItems approve-ideas verdict-delivery deps wired');

  // "Always allow messaging a running flow": the composer can send while an SDK
  // run is EXECUTING; the text is buffered on the SAME module-scoped RunExecutor
  // and delivered as the next turn at the drained REST seam (the deliverer is
  // wired into the RunExecutor ctor in initializeServices()). Reuse that instance
  // so the buffer the mutation writes is the one the drain seam reads.
  setQueueInputDeps({
    runExecutor,
  });
  console.log('[Main] runs.queueInput deps wired');

  // Interrupt & send (TASK-301): the SAME nudgeDeps bag (db / runQueues /
  // runExecutor / logger) plus the facade's abort + live-spawn-key seams — the
  // SAME ones laneRewindDepsBag (above) and rewindRunDepsBag use. Deliberately
  // does NOT reuse `awaitTurnStart` — the live-spawn branch buffers the text via
  // `runExecutor.queueInput` and requests the abort, then returns immediately;
  // delivery is left entirely to the aborted turn's own drain
  // (`drainQueuedInputAtRest`, reached once `teardownRun` observes the aborted
  // spawn's 'drained' lifecycle transition), not to this mutation awaiting
  // anything itself (see interruptAndSendHandler.ts's header note).
  setInterruptAndSendDeps({
    ...nudgeDeps,
    abortRunSpawn: (spawnKey) => substrateFacade.abort(spawnKey),
    listLiveSpawnKeys: (runId) => substrateFacade.listLiveSpawnKeys(runId),
  });
  console.log('[Main] runs.interruptAndSend deps wired');

  // IDEA-030 / TASK-817: wire the live-input relay (the ONLY post-spawn input
  // path into a running interactive REPL). Both methods route through the
  // SubstrateDispatchFacade, which dispatches to the interactive manager's live
  // PTY and NO-OPs for the SDK substrate (Q3 byte-identical). runId === panelId
  // per the orchestrator invariant, so the facade maps directly.
  // IDEA-030 / TASK-818: endSession is the explicit-termination seam for a
  // persistent live process — the close-out mutations (merge / createPr /
  // dismiss) call it BEFORE worktree removal so the interactive PTY's spawn
  // promise resolves (and a warm SDK query() is killed). It rides the SAME
  // RelayDeps bag (the single bag for live-session collaborators) and routes
  // through the facade, which dispatches per substrate.
  setRelayDeps({
    relayInput: (runId, text) => substrateFacade.relayInput(runId, text),
    relayResize: (runId, cols, rows) => substrateFacade.relayResize(runId, cols, rows),
    endSession: (runId) => substrateFacade.endSession(runId),
    killSession: (runId) => substrateFacade.killSession(runId),
    getPtyBacklog: (runId) => substrateFacade.getPtyBacklog(runId),
  });
  console.log('[Main] runs.relayInput/relayResize/endSession/killSession/getPtyBacklog deps wired');

  // Wire the run user-shell (worktree-terminal feature): plain $SHELL PTYs in
  // the run's worktree, keyed by terminalId, backing the run "Terminal" tabs (a
  // run can host MULTIPLE via ＋terminal; the primary's terminalId === runId). The
  // cwd is resolved from workflow_runs.worktree_path (flow runs have no sessions
  // row, so they can't use the panel/session terminal stack). Raw bytes stream to
  // the renderer on `cyboflow:shell:<terminalId>` (mirrors the agent PTY's
  // cyboflow:pty:<runId>); input/resize/backlog/close ride tRPC (setRunShellDeps).
  // Independent of the RunExecutor, so a shell — and any dev server it launched —
  // SURVIVES run completion; close() reaps every terminal for a run at close-out
  // and destroyAll() at app quit.
  runShellManager = new RunShellManager(
    (runId) => {
      const row = db
        .prepare('SELECT worktree_path FROM workflow_runs WHERE id = ?')
        .get(runId) as { worktree_path: string | null } | undefined;
      return row?.worktree_path ?? null;
    },
    (terminalId, chunk) => {
      getMainWindow()?.webContents.send(`cyboflow:shell:${terminalId}`, chunk);
    },
    (file, args, options) => pty.spawn(file, args, options),
  );
  setRunShellDeps({
    open: (runId, terminalId) => runShellManager!.open(runId, terminalId),
    write: (terminalId, data) => runShellManager!.write(terminalId, data),
    resize: (terminalId, cols, rows) => runShellManager!.resize(terminalId, cols, rows),
    getBacklog: (terminalId) => runShellManager!.getBacklog(terminalId),
    closeOne: (terminalId) => runShellManager!.closeOne(terminalId),
    close: (runId) => runShellManager!.close(runId),
  });
  console.log('[Main] runs.shellOpen/shellInput/shellResize/shellBacklog/shellClose deps wired');

  // GAP-B: wire the run close-out (merge / dismiss + worktree cleanup) deps.
  // worktreeManager.removeWorktreeByPath takes the run's absolute nested
  // worktree path; getProjectById resolves the project path from project_id.
  setRunCloseoutDeps({
    worktreeManager: {
      getProjectMainBranch: (projectPath) => worktreeManager.getProjectMainBranch(projectPath),
      squashAndMergeWorktreeToMain: (projectPath, worktreePath, mainBranch, commitMessage) =>
        worktreeManager.squashAndMergeWorktreeToMain(projectPath, worktreePath, mainBranch, commitMessage),
      mergeWorktreeToMain: (projectPath, worktreePath, mainBranch) =>
        worktreeManager.mergeWorktreeToMain(projectPath, worktreePath, mainBranch),
      removeWorktreeByPath: (projectPath, worktreePath) =>
        worktreeManager.removeWorktreeByPath(projectPath, worktreePath),
      deleteBranch: (projectPath, branchName, opts) =>
        worktreeManager.deleteBranch(projectPath, branchName, opts),
      gitPush: (worktreePath) => worktreeManager.gitPush(worktreePath),
      getRemoteUrlAndBranch: (worktreePath) => worktreeManager.getRemoteUrlAndBranch(worktreePath),
    },
    sessionManager: {
      getProjectById: (projectId) => {
        const p = sessionManager.getProjectById(projectId);
        return p ? { path: p.path } : undefined;
      },
    },
    // Close-out clears the run's pending approvals (settles in-memory entries
    // + sweeps DB-only `pending` rows) so dismiss/merge/PR don't leave orphaned
    // items in the review queue.
    clearPendingApprovalsForRun: (runId) =>
      ApprovalRouter.getInstance().clearPendingForRun(runId),
    // Monitor-unify: at terminal close-out, tear down the run's on-demand monitor —
    // its per-run inject plumbing (RunExecutor) AND its registry entry. The monitor
    // outlives the walk (chat-at-rest), so this is the ONLY place it goes away.
    disposeMonitorResources: (runId) => {
      runExecutor.disposeMonitorResources(runId);
      MonitorRegistry.getInstance().unregister(runId);
    },
    // TASK-057: kill the run's detached ui-prototype http.server at close-out
    // (merge / createPr / dismiss). Fail-soft is handled inside the router.
    reapPrototypeServers: (runId) =>
      prototypeServerReaper.reapForRun(getCyboflowSubdirectory('artifacts', 'runs', runId)),
    // Visual-verify cleanup on the MERGE / CREATE-PR close-out path. Deliberately
    // the SAME closure the cancel/dismiss bag above wires, so both ways a run can
    // end reach one implementation: without it, merging left a draining
    // verification to deliver a finding onto a closed-out run. Fail-soft inside
    // the router; tryGetInstance keeps it a no-op when verification is disabled.
    cancelVerificationsForRun: (runId) =>
      VerificationScheduler.tryGetInstance()?.cancelForRun(runId),
    // Native task-tracking (migration 014): merge/createPr/dismiss stamp the
    // run's outcome and recompute the linked task's derived execution stage.
    // getInstance() resolves the singleton initialized during service construction.
    taskStageDeriver: TaskChangeRouter.getInstance(),
  });
  console.log('[Main] runs.merge/dismiss deps wired');

  return { runShellManager };
}
