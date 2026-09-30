/**
 * programmaticRunnerComposition — the programmatic-run driver's composition
 * root, extracted from index.ts's initializeServices() (GitHub issue #19, the
 * god-file split, step 16). It builds the DefaultProgrammaticRunner and its
 * whole deps literal: the step reporter, the human / blocking / systemic /
 * visual gates, the per-step agent + role resolvers, the on-demand monitor
 * factory, the host-driven fan-out lane driver (incl. the commit-integrity
 * probe), and the late-bound monitor lane-triage / review-loop / escalation
 * sinks. The body is index.ts's verbatim, apart from:
 *
 * - The monitor-session builder the factory publishes is RETURNED
 *   (`buildMonitorSession`) instead of assigned to index.ts's module holder;
 *   the call site assigns it. The factory runs synchronously inside the
 *   constructor literal, so the holder is set before anything can read it,
 *   exactly as before.
 * - index.ts's module-level late-bound holders are read through GETTERS, at
 *   call time, because every one of them is assigned AFTER this runs (in the
 *   app.whenReady() tRPC dep-wiring block, or — for the runbook status — kept
 *   lazy on purpose so an unset holder reads as UNKNOWN):
 *     getMonitorRetryStep            → monitorRetryStep
 *     getMonitorSwitchToOrchestrated → monitorSwitchToOrchestrated
 *     getMonitorSteeringActions      → monitorSteeringActions
 *     getLaneTriageActions           → laneTriageActions
 *     getMonitorFindingSink          → monitorFindingSink
 *     getSetAsideFindingSink         → setAsideFindingSink
 *     getGateEscalationSinks         → gateEscalationSinks
 *     getVerifyRunbookStatus         → verifyRunbookStatus
 *   Each ternary over a holder became a block body that reads the getter once
 *   into a same-named local, then runs the original ternary unchanged.
 * - `MonitorSteeringActions` (the holder's interface) and the
 *   `STEERING_NOT_WIRED` fallback moved here from index.ts; index.ts imports
 *   the interface type back.
 *
 * Passed by value (each assigned exactly once, before this runs, and never
 * reassigned): substrateFacade, workflowRegistry, configManager, plus the
 * initializeServices() consts (rawDb, cyboflowDb, cyboflowLogger,
 * claudeExecutablePath, sprintLaneStore, runbookBootstrapStamps,
 * ideaBodyReader).
 *
 * A SIBLING of index.ts on purpose — composition-root code that imports
 * concrete services, so it must stay OUT of main/src/orchestrator/** (the
 * standalone-typecheck invariant scans that tree). No unit test, as there was
 * none over initializeServices(); the collaborators' own suites cover the seams.
 *
 * ORDER IS LOAD-BEARING at the call site: substrateFacade must already exist
 * (it is the spawner), and the runner must be built before RunExecutor, which
 * takes it as a constructor arg.
 */

import type Database from 'better-sqlite3';
import { isModelUsable } from './services/modelAvailabilityService';
import { resolveRunEffectiveAgents } from './services/panels/claude/agentOverlayWriter';
import { bareModelId } from '../../shared/agents/modelContext';
import { reviewItemChangeEvents, reviewItemProjectChannel } from './orchestrator/reviewItemRouter';
import { HumanStepManager } from './orchestrator/humanStepManager';
import { DefaultProgrammaticRunner } from './orchestrator/programmatic/defaultProgrammaticRunner';
import { buildReviewQueueHumanGate } from './orchestrator/humanGateWiring';
import { ReviewQueueBlockingItemsGate } from './orchestrator/programmatic/blockingItemsGate';
import { buildSystemicPauseGate } from './orchestrator/systemicPauseGateWiring';
import { SchedulerVisualVerifyGate } from './orchestrator/programmatic/visualVerifyGate';
import { parsePorcelainPaths } from './orchestrator/programmatic/commitIntegrity';
import {
  DefaultMonitorSession,
  DefaultHistoryReader,
  type MonitorActionResult,
  type MonitorContext,
  type MonitorSession,
} from './orchestrator/programmatic/monitor';
import { makeSdkStructuredQuery, makeSdkTextQuery } from './orchestrator/programmatic/monitorQuery';
import { StepResultStore } from './orchestrator/stepResultStore';
import { verificationEvents, verificationChannel } from './orchestrator/verify/verificationScheduler';
import { gateRuntimePin } from './orchestrator/stepSpawnTarget';
import type {
  buildMonitorFindingSink,
  buildSetAsideFindingSink,
  GateEscalationSinks,
  LaneTriageActions,
} from './orchestrator/monitorActionSinks';
import type { ClaudeStreamEvent } from '../../shared/types/claudeStream';
import type { IdeaBodyReaderLike } from './orchestrator/runExecutor';
import { buildSeedTasksBlock } from './orchestrator/seedTasksBlock';
import { listRunOwnedIdeaIds } from './orchestrator/runEntityOwnership';
import { readRunDigest } from './orchestrator/runDigestReader';
import { buildStepTransitionEvent } from './orchestrator/stepTransitionBridge';
import { runGitAsync } from './utils/runGit';
import { checkWorktreeBuildSlots } from './orchestrator/programmatic/laneBuildSlotsWiring';
import type { VerifyRunbookStatusLike } from './orchestrator/trpc/context';
import type { SubstrateDispatchFacade } from './services/substrateDispatchFacade';
import type { WorkflowRegistry } from './orchestrator/workflowRegistry';
import type { ConfigManager } from './services/configManager';
import type { SprintLaneStore } from './orchestrator/sprintLaneStore';
import type { RunbookBootstrapStampStore } from './orchestrator/verify/bootstrapStampStore';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

// Monitor-actuation seam (the 10 confirm-gated steering actions: add/remove/edit
// task, skip/unskip/steer step, the whole-run rewind, the PER-LANE rewind,
// resolve review item, file note) — the shape of index.ts's late-bound
// `monitorSteeringActions` holder (see its docblock there).
export interface MonitorSteeringActions {
  addTask(runId: string, input: { title: string; body?: string; priority?: string }): Promise<MonitorActionResult>;
  removeTask(runId: string, input: { taskRef: string }): Promise<MonitorActionResult>;
  editTask(
    runId: string,
    input: { taskRef: string; title?: string; body?: string; priority?: string },
  ): Promise<MonitorActionResult>;
  skipStep(runId: string, input: { stepId: string }): Promise<MonitorActionResult>;
  unskipStep(runId: string, input: { stepId: string }): Promise<MonitorActionResult>;
  steerStep(
    runId: string,
    input: { stepId: string; guidance: string; taskRef?: string },
  ): Promise<MonitorActionResult>;
  rewindToStep(runId: string, input: { stepId: string }): Promise<MonitorActionResult>;
  rewindLaneToStep(
    runId: string,
    input: { taskRef: string; stepId: string },
  ): Promise<MonitorActionResult>;
  resolveReviewItem(
    runId: string,
    input: { reviewItemId: string; outcome?: 'approve' | 'reject' | 'revise'; resolution?: string },
  ): Promise<MonitorActionResult>;
  fileNote(runId: string, input: { title: string; body?: string }): Promise<MonitorActionResult>;
}

/** Fallback when a steering action fires before the dep-wiring block ran. */
const STEERING_NOT_WIRED: MonitorActionResult = {
  ok: false,
  message: "That action isn't available yet — try again in a moment.",
};

type BuildMonitorSession = (
  ctx: MonitorContext,
  injectEvent: ((event: ClaudeStreamEvent) => void) | undefined,
) => MonitorSession;

export interface ProgrammaticRunnerCompositionDeps {
  substrateFacade: SubstrateDispatchFacade;
  rawDb: Database.Database;
  cyboflowDb: DatabaseLike;
  cyboflowLogger: LoggerLike;
  configManager: ConfigManager;
  workflowRegistry: WorkflowRegistry;
  claudeExecutablePath: string | undefined;
  sprintLaneStore: SprintLaneStore;
  /** From composeVerification(). */
  runbookBootstrapStamps: RunbookBootstrapStampStore;
  /** initializeServices()'s idea-body reader, shared with RunExecutor. */
  ideaBodyReader: IdeaBodyReaderLike;
  /** Late-bound (wired in the app.whenReady() tRPC dep-wiring block) — read at call time. */
  getMonitorRetryStep: () => ((runId: string, stepId?: string) => Promise<MonitorActionResult>) | null;
  /** Late-bound (wired in the app.whenReady() tRPC dep-wiring block) — read at call time. */
  getMonitorSwitchToOrchestrated: () => ((runId: string, reason: string) => Promise<MonitorActionResult>) | null;
  /** Late-bound (wired in the app.whenReady() tRPC dep-wiring block) — read at call time. */
  getMonitorSteeringActions: () => MonitorSteeringActions | null;
  /** Late-bound (monitorActionSinks wiring in app.whenReady()) — read at call time. */
  getLaneTriageActions: () => LaneTriageActions | null;
  /** Late-bound (monitorActionSinks wiring in app.whenReady()) — read at call time. */
  getMonitorFindingSink: () => ReturnType<typeof buildMonitorFindingSink> | null;
  /** Late-bound (monitorActionSinks wiring in app.whenReady()) — read at call time. */
  getSetAsideFindingSink: () => ReturnType<typeof buildSetAsideFindingSink> | null;
  /** Late-bound (monitorActionSinks wiring in app.whenReady()) — read at call time. */
  getGateEscalationSinks: () => GateEscalationSinks | null;
  /** index.ts's verifyRunbookStatus holder — read LAZILY (an unset holder resolves null). */
  getVerifyRunbookStatus: () => VerifyRunbookStatusLike | undefined;
}

export interface ProgrammaticRunnerComposition {
  programmaticRunner: DefaultProgrammaticRunner;
  /** Published for the lazy monitor rehydrator (index.ts's buildMonitorSession holder). */
  buildMonitorSession: BuildMonitorSession | null;
}

export function composeProgrammaticRunner(
  deps: ProgrammaticRunnerCompositionDeps,
): ProgrammaticRunnerComposition {
  const {
    substrateFacade,
    rawDb,
    cyboflowDb,
    cyboflowLogger,
    configManager,
    workflowRegistry,
    claudeExecutablePath,
    sprintLaneStore,
    runbookBootstrapStamps,
    ideaBodyReader,
    getMonitorRetryStep,
    getMonitorSwitchToOrchestrated,
    getMonitorSteeringActions,
    getLaneTriageActions,
    getMonitorFindingSink,
    getSetAsideFindingSink,
    getGateEscalationSinks,
    getVerifyRunbookStatus,
  } = deps;

  // Assigned synchronously by the monitorFactory IIFE below, then returned.
  let buildMonitorSession: BuildMonitorSession | null = null;

  // Programmatic-run driver (execution-model seam, Stage 2). When a run's
  // immutable `execution_model` stamp is 'programmatic', RunExecutor delegates the
  // whole run to this collaborator: host code (the WorkflowController) walks the
  // run's DAG, running each step as a scoped agent turn via the SAME spawn surface
  // (substrateFacade), driving the live timeline through buildStepTransitionEvent
  // (the same path cyboflow_report_step uses), and resolving human gates by
  // opening a blocking review item via HumanStepManager + awaiting its resolution
  // on reviewItemChangeEvents. Default 'orchestrated' runs never touch this.
  const programmaticRunner = new DefaultProgrammaticRunner({
    spawner: substrateFacade,
    // Enables the controller's agentless visual-verify enqueue capability
    // (enqueueTaskVerification — verification-agent redesign §5.3): absent, the
    // step cleanly skips (fail-open) and visual verification never fires on the
    // programmatic plane.
    db: rawDb,
    reporter: {
      report: (runId, stepId, status) =>
        void buildStepTransitionEvent(runId, stepId, status, cyboflowDb, cyboflowLogger),
    },
    gate: buildReviewQueueHumanGate({
      events: reviewItemChangeEvents,
      channelFor: reviewItemProjectChannel,
      logger: cyboflowLogger,
    }),
    // Per-step idea scope for programmatic prompts. The ownership projection
    // unions workflow_runs.seed_idea_id with ideas created by this run, so Ship's
    // raw-prompt path picks up the idea its context step creates before optional
    // design steps evaluate UI_PROTOTYPE / ARCH_DESIGN.
    runOwnedIdeaIdsProvider: (runId) => listRunOwnedIdeaIds(cyboflowDb, runId),
    // §11 (lane-runbook-bootstrap): the files this run's bootstrap committed,
    // rendered as a do-not-touch list on address-review. That step "fixes in
    // place", and both files are booby-trapped for a well-meant fix — the
    // runbook's proof is content-addressed against the committed bytes, and the
    // rung-1 config edit is what makes the environment stand up at all.
    bootstrapProtectedPathsProvider: (runId) => runbookBootstrapStamps.writtenPathsForRun(runId),
    // Per-step agent-runtime resolver (Codex-per-step mixing): resolves the run's
    // FULL effective agent set (project overrides + workflow agentConfigs + variant
    // deltas — the same layering the agent overlay writes to disk) and looks up the
    // requested agentKey's runtime/model/providerModel/effort. Absent EVERY override
    // (unoverridden agent) -> undefined, so the step spawns under the run-level
    // provider/runtime/model with no per-agent effort. Effort is returned even
    // without a runtime override so a Claude agent can carry a reasoning-effort pin
    // (IDEA-029), and `model` likewise so a Claude agent can carry a MODEL pin: a
    // programmatic step turn IS the agent (a top-level spawn), so the agent
    // overlay's `model:` frontmatter never binds on this plane and this resolver is
    // the pin's only channel. The alias is resolved to its concrete snapshot here
    // (mirroring the overlay writer) so the spawn receives a real model id.
    resolveStepAgent: (runId, agentKey) => {
      const eff = resolveRunEffectiveAgents(rawDb, runId);
      const a = eff.find((e) => e.agentKey === agentKey);
      if (!a || (!a.runtime && !a.effort && !a.model && !a.providerModel)) return undefined;
      // Provider-access gate for PER-AGENT runtime pins. `agentConfigs` can be
      // written by the MCP workflow-config tools as well as the editor, so a pin
      // naming a provider the user switched off in Settings → Integrations can
      // reach here even though the editor hides it. Drop just the runtime pin
      // (keeping model/effort) so the step falls back to the run-level provider,
      // which createRun already resolved onto an ENABLED provider — same
      // fail-soft shape as the CLAUDE_ONLY_AGENT_KEYS drop. Shared with the
      // per-step model rail (runStepModels.ts) via stepSpawnTarget.ts.
      const pinnedRuntime = gateRuntimePin(a.runtime, (p) => configManager.isAgentProviderEnabled(p));
      if (a.runtime && pinnedRuntime === undefined) {
        cyboflowLogger.warn(
          `[resolveStepAgent] dropping ${a.runtime} pin for agent '${agentKey}' — provider disabled in Settings → Integrations`,
        );
      }
      // bareModelId resolves the alias to the current concrete snapshot at the
      // agent's DEFAULT window and strips any `[1m]` suffix — so a per-agent
      // `opus` pin spawns `claude-opus-5-5` (default window), matching the
      // orchestrated overlay's `model:` frontmatter semantics (modelContext.ts),
      // NOT the 1M variant a run-level `opus` picker would select. Intentional:
      // per-agent pins are window-agnostic and consistent across both planes.
      const model = bareModelId(a.model, isModelUsable);
      return {
        ...(pinnedRuntime ? { runtime: pinnedRuntime } : {}),
        ...(model ? { model } : {}),
        // a.providerModel is already normalized (providerModel ?? codexModel) by
        // effectiveAgents; codexModel mirrors it so a not-yet-migrated consumer of
        // this return shape (there is none left in-tree, but the field stays a
        // read-compat alias) still sees the correct value.
        ...(a.providerModel ? { providerModel: a.providerModel, codexModel: a.providerModel } : {}),
        ...(a.effort ? { effort: a.effort } : {}),
      };
    },
    // Direct step dispatch: the role's effective prompt (same layering as above).
    resolveStepRole: (runId, agentKey) => {
      const systemPrompt = resolveRunEffectiveAgents(rawDb, runId).find((e) => e.agentKey === agentKey)?.systemPrompt;
      return systemPrompt ? { systemPrompt } : undefined;
    },
    // Blocking-review-items checkpoint: parks a programmatic run at each step
    // boundary while a PENDING BLOCKING review_item exists (e.g. a blocking finding
    // the agent recorded), awaits it clearing on reviewItemChangeEvents, then
    // resumes. Reuses HumanStepManager for the park/resume/count primitives so the
    // same aggregate-unblock invariant governs both gate decisions and findings.
    blockingGate: new ReviewQueueBlockingItemsGate(
      HumanStepManager.getInstance(),
      reviewItemChangeEvents,
      reviewItemProjectChannel,
      cyboflowLogger,
    ),
    // Systemic-pause gate (usage/rate-limit park + auto-resume): see systemicPauseGateWiring.ts.
    systemicGate: buildSystemicPauseGate({
      events: reviewItemChangeEvents,
      channelFor: reviewItemProjectChannel,
      logger: cyboflowLogger,
    }),
    // Visual merge-gate (programmatic actuation): closes the prose-only boundary so
    // a PROGRAMMATIC sprint parks each lane after visual-verify, awaits the async
    // verdict the VerificationScheduler delivers, and re-dispatches implement on a
    // FAIL (or fails the lane at the cap) — instead of integrating prematurely or
    // leaving a FAILed lane parked. Subscribes to the scheduler's verificationEvents
    // + reads the merge-gate's lane write. Inert for verify-disabled / non-sprint runs.
    visualGate: new SchedulerVisualVerifyGate({
      db: cyboflowDb,
      events: verificationEvents,
      channelFor: verificationChannel,
      logger: cyboflowLogger,
    }),
    // ON-DEMAND monitor (the monitor-unify refactor): the single triage + chat
    // human-seam plane, folding the old Stage 3 supervisor + supervisor-chat into
    // one token-frugal `MonitorSession` in the run's existing Chat pane. ALWAYS ON
    // for programmatic runs (supervisor-role redesign, 2026-07-05 — the old
    // `programmaticSupervisor` opt-in is gone): the supervisor is a Q&A partner the
    // human can query at ANY point, and escalations surface in BOTH the chat and
    // the review queue. A `DefaultMonitorSession` over the real on-demand query fns
    // (monitorQuery.ts) + a HistoryReader bound to cyboflowDb; it reads the WHOLE
    // history ONLY when it must act, and costs zero tokens during routine progress.
    // The run's `injectEvent` (2nd factory arg, from the run context — Slice B) is
    // owned by the session so `converse` renders both sides of an exchange into the
    // Chat pane (the tRPC `monitor.send` seam); the runner registers the session in
    // MonitorRegistry so the router reaches it. NOT headlessly verifiable — it
    // makes a real Claude call.
    monitorFactory: ((): ((
      ctx: MonitorContext,
      injectEvent: (event: ClaudeStreamEvent) => void,
    ) => MonitorSession | undefined) => {
      const structuredQuery = makeSdkStructuredQuery(claudeExecutablePath, cyboflowLogger);
      const textQuery = makeSdkTextQuery(claudeExecutablePath, cyboflowLogger);
      // 3rd arg = the RUN-DELIVERABLES reader (CR-6): what this run produced,
      // folded into the gate + review-loop prompts.
      const history = new DefaultHistoryReader(cyboflowDb, cyboflowLogger, (r) => readRunDigest(cyboflowDb, r, cyboflowLogger));
      // Also published to the module-scoped buildMonitorSession holder so the
      // lazy monitor rehydrator (wired in the tRPC dep-wiring block) builds
      // byte-identical sessions when reviving a run's chat after an app restart.
      const buildSession = (
        ctx: MonitorContext,
        injectEvent: ((event: ClaudeStreamEvent) => void) | undefined,
      ): MonitorSession =>
        new DefaultMonitorSession({
          ctx,
          history,
          structuredQuery,
          textQuery,
          injectEvent,
          // Monitor-actuation seam: the retry_step action executes through the
          // SAME retryRunHandler chokepoint as runs.retryStep, bound lazily via
          // the module-scoped holder (the RunExecutor does not exist yet at
          // monitorFactory construction time — see monitorRetryStep's docblock).
          actions: {
            retryStep: (stepId) => {
              const monitorRetryStep = getMonitorRetryStep();
              return monitorRetryStep
                ? monitorRetryStep(ctx.runId, stepId)
                : Promise.resolve({
                    ok: false,
                    message: 'Retry is not wired yet — try again in a moment.',
                  });
            },
            switchToOrchestrated: (reason) => {
              const monitorSwitchToOrchestrated = getMonitorSwitchToOrchestrated();
              return monitorSwitchToOrchestrated
                ? monitorSwitchToOrchestrated(ctx.runId, reason)
                : Promise.resolve({
                    ok: false,
                    message: 'Handover is not wired yet — try again in a moment.',
                  });
            },
            // The 9 confirm-gated steering actions, all delegating to the single
            // late-bound monitorSteeringActions holder (wired in the dep-wiring
            // block). Each threads the session's own runId.
            addTask: (input) => {
              const monitorSteeringActions = getMonitorSteeringActions();
              return monitorSteeringActions
                ? monitorSteeringActions.addTask(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED);
            },
            removeTask: (input) => {
              const monitorSteeringActions = getMonitorSteeringActions();
              return monitorSteeringActions
                ? monitorSteeringActions.removeTask(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED);
            },
            editTask: (input) => {
              const monitorSteeringActions = getMonitorSteeringActions();
              return monitorSteeringActions
                ? monitorSteeringActions.editTask(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED);
            },
            skipStep: (input) => {
              const monitorSteeringActions = getMonitorSteeringActions();
              return monitorSteeringActions
                ? monitorSteeringActions.skipStep(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED);
            },
            unskipStep: (input) => {
              const monitorSteeringActions = getMonitorSteeringActions();
              return monitorSteeringActions
                ? monitorSteeringActions.unskipStep(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED);
            },
            steerStep: (input) => {
              const monitorSteeringActions = getMonitorSteeringActions();
              return monitorSteeringActions
                ? monitorSteeringActions.steerStep(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED);
            },
            rewindToStep: (input) => {
              const monitorSteeringActions = getMonitorSteeringActions();
              return monitorSteeringActions
                ? monitorSteeringActions.rewindToStep(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED);
            },
            rewindLaneToStep: (input) => {
              const monitorSteeringActions = getMonitorSteeringActions();
              return monitorSteeringActions
                ? monitorSteeringActions.rewindLaneToStep(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED);
            },
            resolveReviewItem: (input) => {
              const monitorSteeringActions = getMonitorSteeringActions();
              return monitorSteeringActions
                ? monitorSteeringActions.resolveReviewItem(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED);
            },
            fileNote: (input) => {
              const monitorSteeringActions = getMonitorSteeringActions();
              return monitorSteeringActions
                ? monitorSteeringActions.fileNote(ctx.runId, input)
                : Promise.resolve(STEERING_NOT_WIRED);
            },
          },
          logger: cyboflowLogger,
        });
      buildMonitorSession = buildSession;
      return buildSession;
    })(),
    // Host-driven fan-out lane substrate (generalize-parallel-fan-out): builds a
    // per-run FanOutDriver bound to the run's batch_id so the WorkflowController can
    // resolve a fanOut step's item set + drive a sprint lane per item ON THE
    // PROGRAMMATIC PLANE. Reuses the SAME sprintLaneStore already wired below — the
    // lane events fire on sprintLaneChannel(runId), so useSprintLanes lights up live
    // with zero new subscription. Returns undefined when the run carries no batch_id
    // (not a seeded sprint) ⇒ the host gets no driver ⇒ no host-driven fan-out
    // (byte-identical to today; orchestrated sprints still drive lanes via the MCP
    // backstop). driveLane is fail-soft — a lane-store error is swallowed + logged so
    // a broken lane write never aborts the controller walk.
    fanOutDriverFactory: ({ batchId }) => {
      if (!batchId) return undefined;
      return {
        resolveItems: (_runId, over) =>
          over === 'tasks'
            ? sprintLaneStore
                .listLanes(batchId)
                // Crash-safe resume: skip lanes already settled (integrated/
                // failed/blocked) so a re-entered fanOut step does not re-run
                // completed work, flip a failed lane back to integrated, or
                // let a BLOCKED child re-enter without its failed parent
                // (Item 6, Codex C3 — a blocked lane never started and stays
                // excluded until an explicit reset, e.g. resetFailedLanes,
                // re-queues it) — mirrors the monotonic-forward guard in
                // deriveLaneFromTaskDispatch. On a fresh run all lanes are
                // 'queued', so every task is returned.
                .filter(
                  (lane) => lane.status !== 'integrated' && lane.status !== 'failed' && lane.status !== 'blocked',
                )
                .map((lane) => lane.taskId)
            : [],
        // DAG ordering (2026-06-22): expose the batch's BLOCKING edges so the
        // controller dispatches a task only after its prerequisites integrate.
        // Reads task_dependencies for the batch's lane task ids; returns taskId →
        // [prerequisite taskIds]. An empty map ⇒ flat waves (no dependencies).
        dependencies: (_runId, over) => {
          const map = new Map<string, string[]>();
          if (over !== 'tasks') return map;
          const taskIds = sprintLaneStore.listLanes(batchId).map((lane) => lane.taskId);
          if (taskIds.length === 0) return map;
          const placeholders = taskIds.map(() => '?').join(',');
          const rows = rawDb
            .prepare(
              `SELECT task_id, depends_on_task_id FROM task_dependencies
                 WHERE kind = 'blocking' AND task_id IN (${placeholders})`,
            )
            .all(...taskIds) as Array<{ task_id: string; depends_on_task_id: string }>;
          for (const row of rows) {
            const prereqs = map.get(row.task_id) ?? [];
            prereqs.push(row.depends_on_task_id);
            map.set(row.task_id, prereqs);
          }
          return map;
        },
        // Same task-file rows the task editor persists are the concurrency source
        // of truth. This deliberately does not inspect task prompt/body text.
        expectedFiles: (_runId, over) => {
          const map = new Map<string, string[]>();
          if (over !== 'tasks') return map;
          const taskIds = sprintLaneStore.listLanes(batchId).map((lane) => lane.taskId);
          if (taskIds.length === 0) return map;
          const placeholders = taskIds.map(() => '?').join(',');
          const rows = rawDb
            .prepare(`SELECT task_id, file_path FROM task_files WHERE task_id IN (${placeholders})`)
            .all(...taskIds) as Array<{ task_id: string; file_path: string }>;
          for (const row of rows) {
            const files = map.get(row.task_id) ?? [];
            files.push(row.file_path);
            map.set(row.task_id, files);
          }
          return map;
        },
        // Commit-integrity backstop: 'integrated' means "complete AND committed
        // in the session worktree", which inner-step verdicts alone cannot
        // establish — a lane whose `git commit` was denied by a permission gate
        // reported green with its changes left untracked on disk (observed live).
        // Read the run's worktree HEAD at lane start and re-read it at lane end;
        // the controller refuses to integrate a lane that moved HEAD nowhere and
        // left the tree dirty. Every failure path (no worktree row, git error)
        // degrades to "no probe" / a rethrow the controller swallows, so the
        // backstop can only withhold a false integrate, never invent a failure.
        beginCommitProbe: async (rid) => {
          const row = rawDb
            .prepare(`SELECT worktree_path FROM workflow_runs WHERE id = ?`)
            .get(rid) as { worktree_path?: unknown } | undefined;
          const worktreePath =
            row && typeof row.worktree_path === 'string' && row.worktree_path.length > 0
              ? row.worktree_path
              : null;
          if (worktreePath === null) return undefined;
          const readHead = async (): Promise<string> =>
            (await runGitAsync(worktreePath, ['rev-parse', 'HEAD'])).trim();
          // `--untracked-files=all` lists files, not collapsed directories, so a new
          // file inside an already-untracked directory still reads as NEW dirt.
          const readDirtyPaths = async (): Promise<string[]> =>
            parsePorcelainPaths(
              await runGitAsync(worktreePath, ['status', '--porcelain', '--untracked-files=all']),
            );
          const startHead = await readHead();
          // Lane-start dirt (a failed sibling's leftovers, a pre-existing edit) is
          // not this lane's uncommitted work. A failed read degrades to "unknown"
          // (newDirtyPaths absent ⇒ every dirty path counts), never to a failure.
          let startDirty: Set<string> | undefined;
          try {
            startDirty = new Set(await readDirtyPaths());
          } catch {
            startDirty = undefined;
          }
          return async () => {
            const endHead = await readHead();
            const dirtyPaths = await readDirtyPaths();
            // §9 (lane-runbook-bootstrap): a RUNBOOK BOOTSTRAP commits into this
            // same shared worktree, mid-lane. HEAD then moves for a reason that
            // is not any lane's work — and since the only case that withholds
            // 'integrated' is "HEAD did not move AND the tree is dirty", an
            // advanced HEAD would let a lane that committed nothing integrate
            // anyway. That is the exact failure this probe exists to catch, so
            // the bootstrap's own commits are subtracted before the comparison.
            //
            // Fail-soft on purpose, in the direction that PRESERVES the probe: a
            // rev-list that throws leaves headAdvanced as the plain sha
            // comparison, which is what shipped.
            let headAdvanced = endHead !== startHead;
            if (headAdvanced) {
              try {
                const bootstrapShas = new Set(runbookBootstrapStamps.commitShasForRun(rid));
                if (bootstrapShas.size > 0) {
                  const between = (
                    await runGitAsync(worktreePath, ['rev-list', `${startHead}..${endHead}`])
                  )
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0);
                  // Compared by PREFIX in both directions: the stamp records
                  // whatever `rev-parse HEAD` returned (full) but a hand-written
                  // or abbreviated sha must still match.
                  headAdvanced = between.some(
                    (sha) =>
                      ![...bootstrapShas].some((b) => sha.startsWith(b) || b.startsWith(sha)),
                  );
                }
              } catch {
                // Keep the plain comparison.
              }
            }
            return {
              headAdvanced,
              dirty: dirtyPaths.length > 0,
              dirtyPaths,
              ...(startDirty !== undefined
                ? { newDirtyPaths: dirtyPaths.filter((path) => !startDirty.has(path)) }
                : {}),
              buildSlots: await checkWorktreeBuildSlots(worktreePath), // committed lane build output at the END HEAD (tri-state)
            };
          };
        },
        // Targeted failed→running un-settle for the controller's MONITOR LANE
        // RESCUE at the visual merge gate: that gate durably writes the lane
        // 'failed' before the controller's awaitVerdict resolves, so a rescued
        // lane is already settled in the store while its walk is still live.
        // Status-guarded to 'failed' inside the store (a no-op otherwise) and
        // fail-soft there too, so no try/catch is needed here.
        reviveLane: ({ itemId }) => {
          sprintLaneStore.reviveLane(batchId, itemId);
        },
        driveLane: ({ runId: rid, itemId, status, currentStepId, attempt, allowedStepIds }) => {
          try {
            sprintLaneStore.updateLane({
              runId: rid,
              batchId,
              taskId: itemId,
              allowedStepIds,
              ...(status !== undefined ? { status } : {}),
              ...(currentStepId !== undefined ? { currentStepId } : {}),
              ...(attempt !== undefined ? { attempt } : {}),
            });
          } catch (err) {
            cyboflowLogger.debug('[fanOutDriver] driveLane skipped (fail-soft)', {
              runId: rid,
              itemId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      };
    },
    // Live batch_id reader (generalize-parallel-fan-out follow-up): backs the
    // fan-out driver provider's mid-walk re-read so `ship`'s materialize-batch
    // step (which UPDATEs workflow_runs.batch_id strictly AFTER this run's
    // ProgrammaticRunContext is built) is honored on the SAME walk instead of a
    // permanently-null one-shot snapshot silently degrading execute-tasks to a
    // single agent step. Reuses the SAME WorkflowRegistry row reader RunExecutor
    // itself uses to snapshot ctx.run at the top of execute() — just re-invoked
    // live rather than once.
    readRunBatchId: (runId) => workflowRegistry.getRunById(runId)?.batch_id ?? null,
    // Sprint task-scope provider (grounding fix, 2026-06-22): resolve the
    // `# Sprint tasks` block body for a sprint run's batch so the programmatic step
    // prompts carry the real task set (reuses the SAME buildSeedTasksBlock helper +
    // readers the orchestrated getPrompt path uses, so both planes emit identical
    // scope). Without it the analyze-dependencies step agent never sees the tasks,
    // concludes "No dependencies", and the dependents fan out concurrently and fail.
    seedTasksProvider: (batchId) =>
      buildSeedTasksBlock(
        batchId,
        { listLaneTaskIds: (b) => sprintLaneStore.listLanes(b).map((lane) => lane.taskId) },
        ideaBodyReader,
        cyboflowLogger,
      ),
    // ── Autonomous LANE TRIAGE (monitor lane rescue) ────────────────────────
    // All three route through the late-bound `laneTriageActions` holder so they
    // reuse the SAME TaskMutationDeps / ReviewItemRouter seams the monitor's chat
    // actions use. Unwired, each degrades to the no-lane-triage posture.
    laneTriageTaskReader: (runId, itemId) => getLaneTriageActions()?.readTask(runId, itemId),
    laneTriageAdjustTask: (runId, input) => {
      const laneTriageActions = getLaneTriageActions();
      return laneTriageActions
        ? laneTriageActions.adjustTask(runId, input)
        : Promise.resolve({ ok: false, reason: 'backlog edits are not wired yet' });
    },
    laneTriageFindingSink: (runId, input) => {
      const laneTriageActions = getLaneTriageActions();
      return laneTriageActions ? laneTriageActions.fileFinding(runId, input) : Promise.resolve();
    },
    // ── SUPERVISED REVIEW LOOP (monitor steering each automatic design lap) ──
    // Same late-bound posture: unwired, BOTH reject — the host then abandons a
    // supervisor resolve, and keeps a set-aside entry in the lap (never dropped).
    monitorFindingSink: (runId, input) => {
      const monitorFindingSink = getMonitorFindingSink();
      return monitorFindingSink ? monitorFindingSink(runId, input) : Promise.reject(new Error('monitor finding sink not wired yet'));
    },
    setAsideFindingSink: (runId, input) => {
      const setAsideFindingSink = getSetAsideFindingSink();
      return setAsideFindingSink ? setAsideFindingSink(runId, input) : Promise.reject(new Error('set-aside finding sink not wired yet'));
    },
    // ── ESCALATION REVIEW (the supervisor's recommendation at a human gate) ──
    // Same late-bound posture: unwired ⇒ an empty queue and a logged-only
    // recommendation, i.e. today's card exactly.
    escalationSinks: () => getGateEscalationSinks(),
    // RUN-LEVEL verification posture (CD1) reads the runbook through the SAME
    // closure the scheduler's §3.2 degrade gate and the health panel's badge use
    // — there must never be a third reading of `verify_runbook_local.status`.
    // Read LAZILY through the module holder (it is assigned inside
    // initializeServices, like every other late-bound probe): an unset holder
    // resolves `null`, which the posture reads as UNKNOWN and answers 'available'
    // for, never as "this project has no runbook".
    verifyRunbookStatus: async (projectId, modality, probePath) => {
      const verifyRunbookStatus = getVerifyRunbookStatus();
      return verifyRunbookStatus ? verifyRunbookStatus(projectId, modality, probePath) : null;
    },
    // §A6 — the posture reads the runbook-optional kill switch LIVE, like gate 3.
    verifyLiveConfig: () => configManager.getVisualVerifyConfig(),
    // Per-step result sink (migration 033): persist each settled step so results
    // are queryable + crash-safe resume can skip individually-completed steps.
    stepResultRecorder: (runId, report) =>
      StepResultStore.tryGetInstance()?.record({
        runId,
        stepId: report.stepId,
        phaseId: report.phaseId,
        outcome: report.outcome,
        attempts: report.attempts,
        ...(report.error !== undefined ? { error: report.error } : {}),
        ...(report.deliberate !== undefined ? { deliberate: report.deliberate } : {}),
      }),
    logger: cyboflowLogger,
  });

  return { programmaticRunner, buildMonitorSession };
}
