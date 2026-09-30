/**
 * proposalExecutorComposition — the global-agent proposal executor's dep
 * wiring, extracted from index.ts's app.whenReady() block (GitHub issue #19,
 * the god-file split, step 26). It assembles ProposalExecutorDeps (the
 * quick-session / launch-run / workflow / review-triage builders, the run
 * cancel + session dismiss compensation primitives, the TaskChangeRouter
 * chokepoint and its read-backs), hands it to setProposalExecutorDeps(), and
 * fires the boot reconciliation of proposals stranded 'executing'. The body is
 * index.ts's verbatim, apart from its inputs arriving as deps.
 *
 * No getters: every module-level holder read here (agentThreadStore, taskQueue,
 * sessionManager, workflowRegistry, databaseService, substrateFacade,
 * interactiveReplManager, runLauncher) is assigned exactly once in
 * initializeServices(), which app.whenReady() awaits before this runs, and
 * never reassigned — so passing the values is identical to index.ts reading
 * the live bindings. experimentsDb, loggerLike, dismissSessionFully and
 * cancelRunDepsBag are whenReady-local consts. The lazy
 * `require('./ipc/claudePanel')` resolves identically from here (same
 * directory as index.ts).
 *
 * A SIBLING of index.ts on purpose — composition-root code that reaches for
 * router singletons and concrete services, so it must stay OUT of
 * main/src/orchestrator/** (the standalone-typecheck invariant scans that
 * tree). No unit test, as there was none over the inline block; the proposal
 * executor and each deps builder carry their own suites.
 *
 * ORDER IS LOAD-BEARING at the call site: after the experiments wiring (the
 * deps mirror it) and before the design-mode-fork launch deps, which reuse the
 * same compensation primitives.
 */

import { randomUUID } from 'node:crypto';
import { TaskChangeRouter } from './orchestrator/taskChangeRouter';
import { ReviewItemRouter } from './orchestrator/reviewItemRouter';
import { AgentOverrideRouter } from './orchestrator/agentOverrideRouter';
import {
  setProposalExecutorDeps,
  reconcileOrphanedExecutingProposals,
  type ProposalExecutorDeps,
  type TaskFieldsSnapshot,
} from './orchestrator/agentThread/proposalExecutor';
import { buildProposalExecutorLaunchDeps } from './orchestrator/agentThread/proposalExecutorLaunchDeps';
import { buildProposalExecutorReviewDeps } from './orchestrator/agentThread/proposalExecutorReviewDeps';
import { buildProposalExecutorQuickSessionDeps } from './orchestrator/agentThread/proposalExecutorQuickSessionDeps';
import { buildProposalExecutorWorkflowDeps } from './orchestrator/agentThread/proposalExecutorWorkflowDeps';
import { generateQuickWorktreeBranchName } from './ipc/session';
import { reportEagerSpawnFailure } from './ipc/eagerSpawnFailure';
import { QUICK_PTY_BRIEFING } from './ipc/quickSessionBriefings';
import { createQuickSessionCore, stampQuickSessionRuntimeConfig } from './services/createQuickSessionCore';
import { panelManager } from './services/panelManager';
import { cancelRunHandler, type CancelRunDeps } from './orchestrator/cancelRunHandler';
import type { AgentThreadDbStore } from './orchestrator/agentThread/agentThreadDbStore';
import type { TaskQueue } from './services/taskQueue';
import type { SessionManager } from './services/sessionManager';
import type { DatabaseService } from './database/database';
import type { InteractiveClaudeManager } from './services/panels/claude/interactiveClaudeManager';
import type { RunLauncher } from './orchestrator/runLauncher';
import type { WorkflowRegistry } from './orchestrator/workflowRegistry';
import type { SubstrateDispatchFacade } from './services/substrateDispatchFacade';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

export interface ProposalExecutorCompositionDeps {
  /** whenReady's experiments DatabaseLike adapter (shared read-backs + transactions). */
  experimentsDb: DatabaseLike;
  loggerLike: LoggerLike;
  /** The FULL safe session-dismiss path (compensation primitive). */
  dismissSessionFully: (sessionId: string) => Promise<void>;
  /** The shared git-neutral runs.cancel bag. */
  cancelRunDepsBag: CancelRunDeps;
  agentThreadStore: AgentThreadDbStore;
  taskQueue: TaskQueue | null;
  sessionManager: SessionManager;
  workflowRegistry: WorkflowRegistry;
  databaseService: DatabaseService;
  substrateFacade: SubstrateDispatchFacade;
  interactiveReplManager: InteractiveClaudeManager;
  runLauncher: RunLauncher;
}

export function composeProposalExecutorDeps(deps: ProposalExecutorCompositionDeps): void {
  const {
    experimentsDb,
    loggerLike,
    dismissSessionFully,
    cancelRunDepsBag,
    agentThreadStore,
    taskQueue,
    sessionManager,
    workflowRegistry,
    databaseService,
    substrateFacade,
    interactiveReplManager,
    runLauncher,
  } = deps;

  // Global-agent proposal executor (migration 071). A user-confirmed proposal
  // executes server-side through the SAME chokepoints, stamped actor:'user' — the
  // executor owns the CAS state machine, the launch compensation saga, and boot
  // reconciliation of rows stranded 'executing' by a crash. Deps mirror
  // setExperimentsDeps: the quick-session core, the run launcher, the FULL safe
  // session-dismiss (dismissSessionFully — cancels hosted runs + removes the
  // worktree) + git-neutral run cancel (the same compensation primitives the A/B
  // rollback ladder uses), the TaskChangeRouter chokepoint, and the workflow registry.
  // Reuse the SINGLE agentThreadStore built in initializeServices (same DB) — the
  // MCP propose handler, this executor, and the tRPC context all share one store.
  const proposalExecutorDeps: ProposalExecutorDeps = {
    store: agentThreadStore,
    newIdempotencyKey: () => randomUUID(),
    // launch-run host sessions + start-quick-session mint/brief delivery: proposalExecutorQuickSessionDeps.ts.
    ...buildProposalExecutorQuickSessionDeps({
      createQuickSessionCore, stampQuickSessionRuntimeConfig, reportEagerSpawnFailure,
      quickSessionCore: { taskQueue: taskQueue!, sessionManager, workflowRegistry, getDb: () => databaseService.getDb(), dismissHalfCreatedSession: dismissSessionFully },
      newSessionName: generateQuickWorktreeBranchName,
      sessionManager, panelManager, substrateFacade, interactiveReplManager,
      getClaudePanelManager: () => (require('./ipc/claudePanel') as typeof import('./ipc/claudePanel')).claudePanelManager,
      ptyBriefing: QUICK_PTY_BRIEFING, logger: loggerLike,
    }),
    // launch-run: workflow resolution (by id or name, custom flows included)
    // + shape-derived seed mapping live in proposalExecutorLaunchDeps.ts.
    ...buildProposalExecutorLaunchDeps({
      workflowRegistry,
      getProjectById: (projectId) => sessionManager.getProjectById(projectId),
      runLauncher,
    }),
    cancelRun: async (runId) => {
      await cancelRunHandler(runId, cancelRunDepsBag);
    },
    dismissSession: dismissSessionFully,
    runExists: (runId) =>
      experimentsDb.prepare('SELECT 1 FROM workflow_runs WHERE id = ?').get(runId) !== undefined,
    applyTaskChange: async (projectId, change) => {
      await TaskChangeRouter.getInstance().applyChange(projectId, change);
    },
    createBacklogItem: async (projectId, item) => {
      // The SAME chokepoint every other entity create goes through, stamped
      // actor:'user' (the human's Confirm click is the authorship). Field mapping
      // is one-to-one with CreateBacklogItem; parentEpicId/originatingIdeaId were
      // already resolved to opaque ids + existence-checked at propose time
      // (mcpQueryHandler's create-backlog-items branch).
      const { taskId } = await TaskChangeRouter.getInstance().applyChange(projectId, {
        actor: 'user',
        entityType: item.taskType,
        title: item.title,
        summary: item.summary,
        body: item.body,
        priority: item.priority,
        category: item.category,
        scope: item.scope,
        parentEpicId: item.parentEpicId ?? null,
        originatingIdeaId: item.originatingIdeaId ?? null,
      });
      const row = experimentsDb
        .prepare(
          `SELECT ref FROM (
               SELECT id, ref FROM ideas
               UNION ALL SELECT id, ref FROM epics
               UNION ALL SELECT id, ref FROM tasks
             ) WHERE id = ?`,
        )
        .get(taskId) as { ref?: unknown } | undefined;
      return { taskId, ...(typeof row?.ref === 'string' ? { ref: row.ref } : {}) };
    },
    readTaskFields: (projectId, taskId) => {
      // The item may be an idea/epic/task (all share priority + stage_id) — resolve
      // it across the three tables the same way TaskChangeRouter's locateEntity does.
      const row = experimentsDb
        .prepare(
          `SELECT priority, stage_id AS stageId FROM (
               SELECT id, project_id, priority, stage_id FROM ideas
               UNION ALL SELECT id, project_id, priority, stage_id FROM epics
               UNION ALL SELECT id, project_id, priority, stage_id FROM tasks
             ) WHERE id = ? AND project_id = ?`,
        )
        .get(taskId, projectId) as TaskFieldsSnapshot | undefined;
      return row ?? null;
    },
    runInTransaction: <T>(fn: () => T): T => experimentsDb.transaction(fn)() as T,
    // edit-workflow + create-workflow: WorkflowRegistry / AgentOverrideRouter closures.
    ...buildProposalExecutorWorkflowDeps({ workflowRegistry, agentOverrideRouter: AgentOverrideRouter.getInstance(), db: experimentsDb }),
    // triage-findings: the ReviewItemRouter chokepoint + a live-state read.
    ...buildProposalExecutorReviewDeps({ reviewItemRouter: ReviewItemRouter.getInstance(), db: experimentsDb }),
    logger: loggerLike,
  };
  setProposalExecutorDeps(proposalExecutorDeps);
  console.log('[Main] proposal executor deps wired');

  // Boot reconciliation: finalize any proposal stranded 'executing' by a crash
  // (verifies observable side effects; NEVER re-runs them). Fire-and-forget +
  // fail-soft — a reconcile failure must never wedge boot.
  void reconcileOrphanedExecutingProposals(proposalExecutorDeps).catch((err) => {
    loggerLike.error('[Main] proposal executor boot reconcile failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
