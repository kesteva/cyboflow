/**
 * experimentsComposition — the A/B experiments router's dep wiring, extracted
 * from index.ts's app.whenReady() tRPC dep-wiring block (GitHub issue #19, the
 * god-file split, step 17). It hands setExperimentsDeps() the concrete
 * collaborators the experiments router orchestrates: the SHA-pinned arm-session
 * core (createQuickSessionCore) plus the arm's runtime stamp + chat-panel seed
 * (eager interactive REPL spawn or SDK panel registration), the run launcher,
 * the entity chokepoint, the git-neutral run cancel, the FULL session-dismiss
 * path, the workflow/variant registry accessors, and the pairwise-decision
 * review-item resolve. The body is index.ts's verbatim, apart from its inputs
 * arriving as deps.
 *
 * No getters: every module-level holder the closures read (configManager,
 * substrateFacade, worktreeManager, taskQueue, sessionManager,
 * workflowRegistry, databaseService, interactiveReplManager, runLauncher) is
 * assigned exactly once in initializeServices(), which app.whenReady() awaits
 * before this runs, and none is ever reassigned — so passing the values is
 * identical to index.ts reading the live bindings. The whenReady-local consts
 * (db, experimentsDb, loggerLike, dismissSessionFully, cancelRunDepsBag) are
 * passed as-is; dismissSessionFully stays in index.ts because the
 * open-idea-session door below the call site reuses it.
 *
 * A SIBLING of index.ts on purpose — composition-root code that imports
 * concrete services, so it must stay OUT of main/src/orchestrator/** (the
 * standalone-typecheck invariant scans that tree). No unit test, as there was
 * none over the inline block; the experiments router's own suite covers the
 * injected seams. The lazy `require('./ipc/claudePanel')` resolves identically
 * from here (same directory as index.ts).
 */

import { setExperimentsDeps } from './orchestrator/trpc/routers/experiments';
import {
  createQuickSessionCore,
  resolveNonClaudeSessionRuntime,
  stampQuickSessionRuntimeConfig,
} from './services/createQuickSessionCore';
import { QUICK_PTY_BRIEFING } from './ipc/quickSessionBriefings';
import { restInteractiveSessionIdle } from './ipc/interactiveSessionRest';
import { panelManager } from './services/panelManager';
import { TaskChangeRouter } from './orchestrator/taskChangeRouter';
import { ReviewItemRouter } from './orchestrator/reviewItemRouter';
import { PairwiseJudgeWorker } from './orchestrator/eval/pairwiseJudgeWorker';
import { cancelRunHandler, type CancelRunDeps } from './orchestrator/cancelRunHandler';
import type { TaskQueue } from './services/taskQueue';
import type { SessionManager } from './services/sessionManager';
import type { WorktreeManager } from './services/worktreeManager';
import type { DatabaseService } from './database/database';
import type { InteractiveClaudeManager } from './services/panels/claude/interactiveClaudeManager';
import type { RunLauncher } from './orchestrator/runLauncher';
import type { WorkflowRegistry } from './orchestrator/workflowRegistry';
import type { ConfigManager } from './services/configManager';
import type { SubstrateDispatchFacade } from './services/substrateDispatchFacade';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

export interface ExperimentsCompositionDeps {
  /** whenReady's shared DatabaseLike adapter (the review-item project lookup). */
  db: DatabaseLike;
  /** The experiments router's own DatabaseLike adapter. */
  experimentsDb: DatabaseLike;
  loggerLike: LoggerLike;
  /** The FULL safe session-dismiss path (cancel hosted runs, archive, remove worktree). */
  dismissSessionFully: (sessionId: string) => Promise<void>;
  /** The shared git-neutral cancel dep bag (runs.cancel uses the same one). */
  cancelRunDepsBag: CancelRunDeps;
  runLauncher: RunLauncher;
  configManager: ConfigManager;
  substrateFacade: SubstrateDispatchFacade;
  worktreeManager: WorktreeManager;
  taskQueue: TaskQueue | null;
  sessionManager: SessionManager;
  workflowRegistry: WorkflowRegistry;
  databaseService: DatabaseService;
  interactiveReplManager: InteractiveClaudeManager;
}

export function composeExperimentsDeps(deps: ExperimentsCompositionDeps): void {
  const {
    db,
    experimentsDb,
    loggerLike,
    dismissSessionFully,
    cancelRunDepsBag,
    runLauncher,
    configManager,
    substrateFacade,
    worktreeManager,
    taskQueue,
    sessionManager,
    workflowRegistry,
    databaseService,
    interactiveReplManager,
  } = deps;

  setExperimentsDeps({
    db: experimentsDb,
    runLauncher,
    // Sprint seed-task cap: the same live Settings override runs.start and the
    // batch picker read, so an experiment arm accepts exactly what a normal
    // sprint launch would.
    getSprintMaxTasks: () => configManager.getSprintMaxTasks(),
    // settleQuickArm write barrier: refuse to rest a quick arm whose session
    // has an agent turn mid-write (grading would snapshot a partial diff).
    // Routed through the facade so every substrate manager is consulted.
    hasActiveAgentTurn: (sessionId) => substrateFacade.hasTurnInFlightForSession(sessionId),
    worktreeManager: {
      getProjectMainBranch: (p) => worktreeManager.getProjectMainBranch(p),
      getHeadCommit: (p) => worktreeManager.getHeadCommit(p),
    },
    createArmSession: async ({ projectId, baseCommittish, nameHint, quickConfig }) => {
      const { session, runId, resolvedSubstrate } = await createQuickSessionCore(
        {
          taskQueue: taskQueue!,
          sessionManager,
          workflowRegistry,
          getDb: () => databaseService.getDb(),
          // A quick arm's config can pass an invalid substrate/runtime combo (the
          // wire schema permits cross-field combos createRun rejects), which throws
          // AFTER the worktree + session row are provisioned — sweep that orphan.
          dismissHalfCreatedSession: dismissSessionFully,
        },
        quickConfig
          ? {
              projectId,
              baseCommittish,
              nameHint,
              requestedSubstrate: quickConfig.substrate,
              agentProvider: quickConfig.agentProvider,
              agentRuntime: quickConfig.agentRuntime,
              agentModel: quickConfig.model,
              requestedAgentMode: quickConfig.permissionMode,
            }
          : // Pin 'sdk' explicitly: an A/B arm session is an INFRASTRUCTURE host
            // (its worktree hosts the arm's workflow runs), not a user quick
            // session, so its sentinel must never inherit the quick-session PTY
            // default (quickSessionDefaultSubstrate). This keeps the arm sentinel
            // 'sdk' exactly as before that default existed.
            { projectId, baseCommittish, nameHint, requestedSubstrate: 'sdk' },
      );
      // Stamp parity with the quick IPC handler, via the SHARED chokepoint
      // (stampQuickSessionRuntimeConfig): the arm's permission-mode pick and
      // the RESOLVED substrate/agent_runtime must land on the SESSION row too
      // — chat spawns read sessions.agent_permission_mode
      // (resolveSessionAgentPermissionMode), and the sessions:input relay
      // branch + frontend substrate gates read sessions.substrate/
      // agent_runtime. Without this the sub-form's substrate and permission
      // picks silently never applied: the arm ran as an SDK session on the
      // global permission default while its run row claimed otherwise. Infra
      // arms (no quickConfig) keep their pre-existing NULL stamps.
      //
      // The runtime is derived GENERICALLY, through the same helper the quick
      // handler's ladder ends in (resolveNonClaudeSessionRuntime): a
      // provider-literal test here used to recognize only codex-sdk, so an
      // omp-sdk arm stamped nothing and the shared chokepoint fell back to
      // deriving claude-sdk from the SDK substrate — the sentinel run row said
      // omp-sdk while sessions.agent_runtime said claude-sdk, and every chat
      // turn in that arm dispatched to Claude. The arm wire schema carries only
      // STORABLE runtimes, so no PTY runtime can appear here.
      if (quickConfig) {
        try {
          const armSessionRuntime = resolveNonClaudeSessionRuntime(quickConfig);
          stampQuickSessionRuntimeConfig(databaseService.getDb(), session.id, {
            resolvedSubstrate,
            ...(armSessionRuntime !== undefined
              ? { sessionAgentRuntime: armSessionRuntime }
              : {}),
            requestedAgentMode: quickConfig.permissionMode,
          });
        } catch (err) {
          // This stamp runs AFTER createQuickSessionCore's compensation window
          // closed, so a throw here would orphan the provisioned session +
          // worktree (the caller never learns the session id and can't sweep
          // it). Compensate exactly like the core: best-effort full dismiss,
          // then rethrow so startExperiment still sees the failure.
          try {
            await dismissSessionFully(session.id);
          } catch (sweepErr) {
            loggerLike.warn('[Main] experiment arm: orphan sweep after stamp failure failed', {
              sessionId: session.id,
              error: sweepErr instanceof Error ? sweepErr.message : String(sweepErr),
            });
          }
          throw err;
        }
      }
      // Seed the quick arm's chat config onto its Claude panel. A quick arm is
      // an interactive session the user drives, but its per-turn model /
      // reasoning-effort are read from PANEL settings at sessions:input spawn
      // time (never from the session row) — and the arm's Claude panel is created
      // bare (lazily, by bootstrapArmSessionPanels). Without seeding it here, the
      // quickConfig model/effort would fall back to the SDK/CLI defaults.
      // Mirrors the quick handler's updatePanelSettings seeding;
      // bootstrapArmSessionPanels is idempotent so it reuses this panel.
      // (fastMode is deliberately NOT part of the arm wire schema — the user
      // can still toggle it per-turn in the session UI after launch.)
      if (quickConfig && resolvedSubstrate === 'interactive') {
        // EAGER PTY SPAWN — parity with sessions:create-quick's interactive
        // branch: without it an interactive arm boots to a DEAD terminal (no
        // REPL until a first ^G-composed sessions:input re-spawns one on
        // demand; direct terminal keystrokes go nowhere). Same contracts as
        // the quick handler: the panel is NOT registered with
        // ClaudePanelManager (the PTY surface never uses the structured
        // claudePanels:* IPC), the runId→panelId translation is seeded
        // BEFORE the spawn so a relay racing the first PTY byte resolves,
        // and startPanel is NEVER awaited (its promise resolves only when
        // the REPL exits — awaiting would deadlock arm creation).
        try {
          const chatPanel = await panelManager.createPanel({
            sessionId: session.id,
            type: 'claude',
            title: 'Chat',
          });
          if (quickConfig.model !== undefined || quickConfig.reasoningEffort !== undefined) {
            databaseService.updatePanelSettings(chatPanel.id, {
              ...(quickConfig.model !== undefined ? { model: quickConfig.model } : {}),
              ...(quickConfig.reasoningEffort !== undefined
                ? { reasoningEffort: quickConfig.reasoningEffort }
                : {}),
            });
          }
          substrateFacade.registerInteractivePanel(runId, chatPanel.id);
          void interactiveReplManager
            .startPanel(
              chatPanel.id,
              session.id,
              session.worktreePath,
              '', // prompt — the briefing rides --append-system-prompt, so the REPL opens idle
              session.permissionMode,
              quickConfig.model,
              undefined, // effort ('ultracode') — not part of the arm wire schema
              undefined, // fastMode — not part of the arm wire schema
              undefined, // resumeSessionId — fresh eager spawn
              quickConfig.reasoningEffort,
              undefined, // userAcknowledgedProviderDisabled — not a resume prompt
              QUICK_PTY_BRIEFING, // session context, NOT a user turn
            )
            .catch((err: unknown) => {
              // Fail-soft (mirrors create-quick): the arm stays usable — the
              // first ^G-composed sessions:input bootstraps the REPL on demand.
              loggerLike.warn('[Main] experiment arm: eager interactive REPL spawn failed', {
                sessionId: session.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          // The REPL is live but IDLE — the briefing rides the system prompt, so
          // this spawn starts no turn. See restInteractiveSessionIdle for why it
          // rests at the turn-end value rather than 'running' or 'stopped'.
          restInteractiveSessionIdle(sessionManager, session.id);
        } catch (err) {
          loggerLike.warn('[Main] experiment arm: interactive chat-panel seed failed', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (
        quickConfig &&
        (quickConfig.model !== undefined || quickConfig.reasoningEffort !== undefined)
      ) {
        try {
          const chatPanel = await panelManager.createPanel({
            sessionId: session.id,
            type: 'claude',
            title: 'Chat',
          });
          // Server-side createPanel skips the frontend panels:create
          // auto-registration (ipc/panels.ts) — but an SDK-substrate arm's
          // chat is driven through the panel-scoped claudePanels/panels IPC,
          // whose manager throws "Panel not registered" for an unregistered
          // panel, and bootstrapArmSessionPanels sees this panel and skips
          // the registering create. Register here (lazy require, mirroring
          // ipc/panels.ts — the handler assigns the export at boot, long
          // before any arm launch) so the arm's FIRST chat turn dispatches.
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { claudePanelManager } = require('./ipc/claudePanel') as {
            claudePanelManager?: {
              registerPanel(panelId: string, sessionId: string): void;
            };
          };
          claudePanelManager?.registerPanel(chatPanel.id, session.id);
          databaseService.updatePanelSettings(chatPanel.id, {
            ...(quickConfig.model !== undefined ? { model: quickConfig.model } : {}),
            ...(quickConfig.reasoningEffort !== undefined
              ? { reasoningEffort: quickConfig.reasoningEffort }
              : {}),
          });
        } catch (err) {
          // Fail-soft: a seeding failure leaves the arm usable (it falls back to
          // SDK/CLI defaults, exactly as before this seed existed) — never abort
          // arm creation over a per-turn config pin.
          loggerLike.warn('[Main] experiment arm: chat-panel config seed failed', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { sessionId: session.id, worktreePath: session.worktreePath, runId };
    },
    taskChangeRouter: TaskChangeRouter.getInstance(),
    dismissSession: dismissSessionFully,
    cancelRun: async (runId) => {
      await cancelRunHandler(runId, cancelRunDepsBag);
    },
    getVariant: (variantId) => workflowRegistry.getVariantById(variantId),
    getWorkflow: (workflowId) => {
      const w = workflowRegistry.getById(workflowId);
      return w ? { id: w.id, name: w.name } : null;
    },
    getProjectPath: (projectId) => {
      const p = sessionManager.getProjectById(projectId);
      return p?.path ?? null;
    },
    setVariantStatus: (variantId, status) => workflowRegistry.setVariantStatus(variantId, status),
    setVariantWeight: (variantId, weight) => workflowRegistry.updateVariant(variantId, { weight }),
    setBaselineRotation: (workflowId, patch) => workflowRegistry.setBaselineRotation(workflowId, patch),
    adoptWorkflowSpec: (workflowId, definition) => workflowRegistry.updateSpec(workflowId, definition),
    // Slice C: experiments.decide resolves the blocking pairwise decision review
    // item via experiment_comparisons.decision_review_item_id. Look up the item's
    // project (review items are project-scoped) then route the resolve through the
    // single ReviewItemRouter chokepoint. Fire-and-forget + fail-soft — a decide
    // must never fail because the notification could not be resolved.
    resolveReviewItem: (reviewItemId) => {
      try {
        const row = db
          .prepare('SELECT project_id AS projectId FROM review_items WHERE id = ?')
          .get(reviewItemId) as { projectId?: number } | undefined;
        if (!row || typeof row.projectId !== 'number') return;
        void ReviewItemRouter.getInstance()
          .applyReviewItem(row.projectId, {
            op: 'resolve',
            actor: 'orchestrator',
            reviewItemId,
            resolution: 'experiment-decided',
          })
          .catch(() => {});
      } catch {
        /* fail-soft: pre-050 DB or missing item — nothing to resolve */
      }
    },
    // Slice C: rerunComparison re-drives the pairwise snapshot+enqueue after
    // deleting the stale comparison row.
    pairwiseMaybeSnapshot: async (experimentId) => {
      const worker = PairwiseJudgeWorker.tryGetInstance();
      if (worker) await worker.maybeSnapshotAndEnqueue(experimentId);
    },
  });
  console.log('[Main] experiments deps wired');
}
