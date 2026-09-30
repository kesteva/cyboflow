/**
 * monitorActionsComposition — the monitor-actuation wiring, extracted from
 * index.ts's app.whenReady() tRPC dep-wiring block (GitHub issue #19, the
 * god-file split, step 19). It builds every action a run's monitor session can
 * take: retry_step (with the systemic-pause fallback), switch_to_orchestrated
 * (+ the final-gate auto-handover), the ten confirm-gated steering actions
 * (task add/remove/edit, skip/unskip/steer incl. live SDK steering delivery,
 * the whole-run and per-lane rewinds, and the two review-queue actions from
 * monitorReviewQueueComposition.ts), the autonomous action sinks (lane triage,
 * review-loop steering, gate escalation), and the lazy monitor rehydrator.
 * Its side effects, in their original order: setFinalGateHandover,
 * setRewindRunDeps (the review queue's "Address review findings" CTA shares
 * the rewind bag), setMonitorRehydrator, plus the boot log lines.
 *
 * The body is index.ts's verbatim, apart from:
 *
 * - The seven late-bound module holders it used to ASSIGN (monitorRetryStep,
 *   monitorSwitchToOrchestrated, monitorSteeringActions, laneTriageActions,
 *   monitorFindingSink, setAsideFindingSink, gateEscalationSinks) are now
 *   same-named consts, RETURNED and assigned at the call site right after
 *   this runs. Nothing reads those holders synchronously during this block —
 *   only monitor sessions / the programmatic runner, at call time — so the
 *   later assignment is unobservable.
 * - One GETTER: `getBuildMonitorSession` → index.ts's buildMonitorSession
 *   holder, read inside the rehydrator's buildSession closure at call time
 *   (it keeps the original lazy read + defensive null throw exactly).
 *
 * Passed by value (each assigned exactly once in initializeServices(), which
 * app.whenReady() awaits before this runs, and never reassigned): runQueues,
 * runExecutor, substrateFacade, workflowRegistry, configManager; plus the
 * whenReady-local consts db, loggerLike and retryRunDepsBag (shared with
 * setRetryRunDeps above the call site).
 *
 * A SIBLING of index.ts on purpose — composition-root code that reaches for
 * router singletons and concrete services, so it must stay OUT of
 * main/src/orchestrator/** (the standalone-typecheck invariant scans that
 * tree). No unit test, as there was none over the inline block; the handlers
 * (retry/handover/rewind/laneRewind/taskMutation), monitorActionSinks,
 * finalGateHandover and monitorRehydration each carry their own suites.
 *
 * ORDER IS LOAD-BEARING at the call site: it must run after setRetryRunDeps
 * (retryRunDepsBag) and before anything consumes the rewind deps.
 */

import { ApprovalRouter } from './orchestrator/approvalRouter';
import { QuestionRouter } from './orchestrator/questionRouter';
import { ReviewItemRouter } from './orchestrator/reviewItemRouter';
import { TaskChangeRouter } from './orchestrator/taskChangeRouter';
import { HumanStepManager } from './orchestrator/humanStepManager';
import { SprintLaneStore } from './orchestrator/sprintLaneStore';
import { StepResultStore } from './orchestrator/stepResultStore';
import { MonitorRegistry, type MonitorActionResult } from './orchestrator/programmatic/monitor';
import { retryRunHandler, type RetryRunDeps } from './orchestrator/retryRunHandler';
import { rewindRunHandler, type RewindRunDeps } from './orchestrator/rewindRunHandler';
import { laneRewindHandler, type LaneRewindDeps } from './orchestrator/laneRewindHandler';
import { handoverRunHandler, type HandoverRunDeps } from './orchestrator/handoverRunHandler';
import { setMonitorRehydrator, setFinalGateHandover } from './orchestrator/trpc/routers/monitor';
import { createFinalGateHandover } from './orchestrator/finalGateHandover';
import { createMonitorRehydrator } from './orchestrator/programmatic/monitorRehydration';
import { composeMonitorReviewQueueActions } from './monitorReviewQueueComposition';
import {
  addTaskToRun,
  removeTaskFromRun,
  editRunTask,
  type TaskMutationDeps,
  type TaskMutationResult,
  type TaskMutationNoOpReason,
} from './orchestrator/taskMutationHandler';
import {
  buildGateEscalationSinks,
  buildLaneTriageActions,
  buildMonitorFindingSink,
  buildSetAsideFindingSink,
  type GateEscalationSinks,
  type LaneTriageActions,
  type MonitorActionSinkDeps,
} from './orchestrator/monitorActionSinks';
import { resolveWorkflowDefinition } from '../../shared/types/workflows';
import { resolveRunFrozenSpec } from './orchestrator/runFrozenSpec';
import { readWorkflowPromptForRow } from './orchestrator/workflowPromptReaderAdapter';
import { runStatusEvents } from './orchestrator/trpc/routers/events';
import { setRewindRunDeps } from './orchestrator/trpc/routers/runs';
import type { MonitorSteeringActions, ProgrammaticRunnerComposition } from './programmaticRunnerComposition';
import type { RunQueueRegistry } from './orchestrator/RunQueueRegistry';
import type { RunExecutor } from './orchestrator/runExecutor';
import type { SubstrateDispatchFacade } from './services/substrateDispatchFacade';
import type { WorkflowRegistry } from './orchestrator/workflowRegistry';
import type { ConfigManager } from './services/configManager';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

export interface MonitorActionsCompositionDeps {
  db: DatabaseLike;
  loggerLike: LoggerLike;
  runQueues: RunQueueRegistry;
  runExecutor: RunExecutor;
  substrateFacade: SubstrateDispatchFacade;
  workflowRegistry: WorkflowRegistry;
  configManager: ConfigManager;
  /** The runs.retryStep deps bag (setRetryRunDeps) — retry_step routes through the SAME bag. */
  retryRunDepsBag: RetryRunDeps;
  /** index.ts's buildMonitorSession holder — read lazily by the rehydrator. */
  getBuildMonitorSession: () => ProgrammaticRunnerComposition['buildMonitorSession'];
}

/** The late-bound holders index.ts assigns from this block's output. */
export interface MonitorActionsComposition {
  monitorRetryStep: (runId: string, stepId?: string) => Promise<MonitorActionResult>;
  monitorSwitchToOrchestrated: (runId: string, reason: string) => Promise<MonitorActionResult>;
  monitorSteeringActions: MonitorSteeringActions;
  laneTriageActions: LaneTriageActions;
  monitorFindingSink: ReturnType<typeof buildMonitorFindingSink>;
  setAsideFindingSink: ReturnType<typeof buildSetAsideFindingSink>;
  gateEscalationSinks: GateEscalationSinks;
}

export function composeMonitorActions(deps: MonitorActionsCompositionDeps): MonitorActionsComposition {
  const {
    db,
    loggerLike,
    runQueues,
    runExecutor,
    substrateFacade,
    workflowRegistry,
    configManager,
    retryRunDepsBag,
    getBuildMonitorSession,
  } = deps;

  // Monitor-actuation binding (retry_step): route the monitor's validated
  // retry action through the SAME retryRunHandler + deps bag as the tRPC
  // mutation, mapping the discriminated result onto a chat-friendly
  // ok/message pair the monitor injects as a follow-up turn.
  //
  // not_retryable fallback: a run PARKED on a live systemic pause (usage-limit
  // item) is awaiting_review WITH an active walk, so retryRunHandler refuses
  // it — but "retry the step" is exactly what resolving the pause item does
  // (ReviewQueueSystemicPauseGate settles 'retry' and the walk re-runs the
  // interrupted step without burning budget). Probe for that item and resolve
  // it through the ReviewItemRouter chokepoint; only when no pause item exists
  // is the refusal surfaced to the user.
  const monitorRetryStep = async (runId: string, stepId?: string): Promise<MonitorActionResult> => {
    const result = await retryRunHandler(runId, stepId, retryRunDepsBag);
    if ('delivered' in result) {
      return { ok: true, message: `Retrying the run from step '${result.stepId}'.` };
    }
    if (result.reason === 'not_retryable') {
      try {
        const pauseItem = await HumanStepManager.getInstance().findPendingSystemicPauseItem(runId);
        if (pauseItem) {
          await ReviewItemRouter.getInstance().applyReviewItem(pauseItem.projectId, {
            op: 'resolve',
            actor: 'orchestrator',
            reviewItemId: pauseItem.reviewItemId,
            resolution: 'retry now (via monitor)',
          });
          return {
            ok: true,
            message: 'Resolved the usage-limit pause — the run is resuming from the interrupted step.',
          };
        }
      } catch (err) {
        loggerLike.warn('[Main] monitor retry_step pause-resolution fallback failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const messages: Record<string, string> = {
      not_found: 'Run not found.',
      not_programmatic: 'Only programmatic runs support step retry.',
      not_retryable: "The run isn't in a retryable state — it must be failed or resting.",
      no_target_step: 'No failed step to retry — name the step id to re-run.',
      unknown_step: `Step '${stepId ?? ''}' is not part of this workflow.`,
      race: 'The run changed state mid-retry — try again.',
    };
    return { ok: false, message: messages[result.reason] ?? `Retry refused (${result.reason}).` };
  };
  console.log('[Main] monitor retry_step action wired');

  // Monitor-actuation binding (switch_to_orchestrated): the one-way
  // programmatic -> orchestrated handover, routed through handoverRunHandler
  // (walk abort -> the sanctioned execution_model flip -> gate sweep ->
  // handover-brief nudge -> orchestrated re-drive). Reuses the SAME db /
  // runQueues / runExecutor / runStatusEvents as the retry bag; the prompt
  // body rides WorkflowRegistry.getById + readWorkflowPromptForRow (keyed by
  // workflow ID — names are not unique across projects), fail-soft to null so
  // a missing prompt degrades to a brief that says so.
  const handoverRunDepsBag: HandoverRunDeps = {
    db,
    runQueues,
    runExecutor,
    emitRunStatusChanged: (runId, status) =>
      runStatusEvents.emit('changed', { runId, status }),
    clearPendingGateItems: (runId) => HumanStepManager.getInstance().clearPendingForRun(runId),
    stopLiveRun: (runId: string) => substrateFacade.abort(runId),
    // Handover tears down the run's monitor (same as terminal close-out's
    // disposeMonitorResources): the orchestrated agent now owns the chat, so the
    // composer must stop routing turns to the read-only monitor. Enforces the
    // "orchestrated runs have no monitor" invariant the rehydrator already asserts.
    disposeMonitor: (runId: string) => {
      runExecutor.disposeMonitorResources(runId);
      MonitorRegistry.getInstance().unregister(runId);
    },
    readWorkflowPrompt: (workflowId) => {
      try {
        const row = workflowRegistry.getById(workflowId);
        return row ? readWorkflowPromptForRow(row).prompt : null;
      } catch {
        return null;
      }
    },
    listStepResults: (runId) => StepResultStore.tryGetInstance()?.listForRun(runId) ?? [],
    logger: loggerLike,
  };
  const monitorSwitchToOrchestrated = async (runId: string, reason: string): Promise<MonitorActionResult> => {
    const result = await handoverRunHandler(runId, reason, handoverRunDepsBag);
    if ('delivered' in result) {
      return {
        ok: true,
        message:
          'Handing the run over to an interactive agent — it will address your request and continue the remaining workflow steps in this chat.',
      };
    }
    const messages: Record<string, string> = {
      not_found: 'Run not found.',
      not_programmatic: 'This run is already running as an interactive agent.',
      not_switchable:
        "The run isn't in a state that can be handed over — it must be running, resting, or failed.",
      race: 'The run changed state mid-handover — try again.',
    };
    return { ok: false, message: messages[result.reason] ?? `Handover refused (${result.reason}).` };
  };
  console.log('[Main] monitor switch_to_orchestrated action wired');

  // Final-gate auto-handover: chatting with a programmatic run parked at its
  // FINAL human gate (or resting for merge) converts it to a full orchestrated
  // agent carrying the message as the agent's first request — no manual
  // switch_to_orchestrated ceremony. Reuses the SAME handoverRunDepsBag (via
  // handoverRunHandler with the finalGate context), the injected step-results
  // source, and RunExecutor.ensureMonitorInjectBridge for the transcript inject.
  // Consulted by cyboflow.monitor.send BEFORE the monitor path (fail-soft).
  setFinalGateHandover(
    createFinalGateHandover({
      db,
      isEnabled: () => configManager.getAutoHandoverAtFinalGateEnabled(),
      listStepResults: (runId) => StepResultStore.tryGetInstance()?.listForRun(runId) ?? [],
      getInjectEvent: (runId) => runExecutor.ensureMonitorInjectBridge(runId),
      handover: (runId, reason, finalGate) =>
        handoverRunHandler(runId, reason, handoverRunDepsBag, { finalGate }),
      logger: loggerLike,
    }),
  );
  console.log('[Main] monitor final-gate auto-handover wired');

  // Monitor steering actions (the 8 non-stopping backlog/step/review edits).
  // All route through chokepoints (TaskChangeRouter / SprintLaneStore /
  // ReviewItemRouter) that own their OWN serialization, so none touches the
  // run's held PQueue — they work while the walk is mid-DAG. skip/unskip/steer
  // write the live RunDirectives the controller reads at the loop head / the
  // SpawnStepRunner reads via its per-step guidance thunk.
  const taskMutationDeps: TaskMutationDeps = {
    db,
    applyTaskChange: (projectId, change) =>
      TaskChangeRouter.getInstance().applyChange(projectId, change),
    applyTaskDelete: (projectId, opts) => TaskChangeRouter.getInstance().applyDelete(projectId, opts),
    laneStore: {
      addLane: (laneArgs) => SprintLaneStore.getInstance().addLane(laneArgs),
      removeLane: (laneArgs) => SprintLaneStore.getInstance().removeLane(laneArgs),
    },
    // Migration 066: recompute the mutated task's execution stage after a
    // mid-sprint add (→ In development) or remove (→ entry stage).
    recomputeTask: (taskId) => TaskChangeRouter.getInstance().recomputeTaskExecutionStage(taskId),
    logger: loggerLike,
  };

  // Map the task-mutation handler's discriminated refusal to a chat-friendly pair.
  const mapTaskResult = (r: TaskMutationResult): MonitorActionResult => {
    if (r.ok) return { ok: true, message: r.message };
    const messages: Record<TaskMutationNoOpReason, string> = {
      not_found: 'Run not found.',
      not_programmatic: 'Only programmatic sprint runs support backlog edits.',
      no_batch: r.detail ?? 'This run has no active sprint batch to edit.',
      task_not_found: `No task matching '${r.detail ?? ''}' in this run's project.`,
      not_eligible: "The task couldn't be made sprint-eligible.",
      already_started: 'That task has already started — too late to change it.',
      not_in_sprint: `Task ${r.detail ?? ''} isn't in this sprint — I can only edit tasks still queued in this run's batch.`,
      duplicate: 'That task is already in the sprint.',
      nothing_to_change: 'Nothing to change — give a new title, body, or priority.',
      lane_error: r.detail ? `Sprint update failed: ${r.detail}` : 'Sprint update failed unexpectedly.',
    };
    return { ok: false, message: messages[r.reason] };
  };

  // A run's project id (review-item + note actions are project-scoped).
  const runProjectId = (runId: string): number | undefined => {
    const row = db
      .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
      .get(runId) as { projectId?: number } | undefined;
    return typeof row?.projectId === 'number' ? row.projectId : undefined;
  };

  // Validate a stepId belongs to a programmatic run's effective workflow
  // definition — so skip/unskip/steer give "unknown step" feedback instead of
  // silently stashing a directive the controller will never honor. Fan-out
  // INNER step ids (e.g. a sprint lane's 'implement' / 'code-review') count:
  // the controller consults the skip set per inner step (driveItem's loop) and
  // the guidance thunk keys on the synthesized inner step id, so directives on
  // them ARE honored — only the OUTER phase steps used to pass this gate,
  // which wrongly refused the monitor exactly the lane steps live steering
  // targets most. (Rewind validates separately against OUTER steps only — the
  // walk's resume machinery is outer-step-indexed.)
  const validateRunStep = (
    runId: string,
    stepId: string,
  ): { ok: true } | { ok: false; message: string } => {
    const row = db
      .prepare('SELECT execution_model AS executionModel FROM workflow_runs WHERE id = ?')
      .get(runId) as { executionModel: string | null } | undefined;
    if (!row) return { ok: false, message: 'Run not found.' };
    if (row.executionModel !== 'programmatic')
      return { ok: false, message: 'Only programmatic runs support step control.' };
    // FROZEN spec, never the live workflows.spec_json — a live read validates
    // step ids against the wrong graph for a variant run / mid-run edit
    // (docs/CODE-PATTERNS.md "Per-run workflow definitions resolve the FROZEN spec").
    const frozen = resolveRunFrozenSpec(db, runId);
    const def = frozen ? resolveWorkflowDefinition(frozen.workflowName, frozen.specJson) : null;
    if (!def) return { ok: false, message: "This run's workflow definition could not be resolved." };
    const exists = def.phases.some((p) =>
      p.steps.some(
        (s) => s.id === stepId || (s.fanOut?.inner.some((inner) => inner.id === stepId) ?? false),
      ),
    );
    if (!exists) return { ok: false, message: `Step '${stepId}' isn't part of this workflow.` };
    return { ok: true };
  };

  // Is `stepId` an OUTER fan-out step of the run's (FROZEN) definition? Such a
  // step never spawns its own agent while lanes exist (the controller walks the
  // synthesized INNER chain instead), and its durable RunDirectives guidance is
  // never re-read — so steer_step treats it as a LIVE-ONLY broadcast to the
  // running sprint lanes (see the steerStep binding below).
  const isOuterFanOutStep = (runId: string, stepId: string): boolean => {
    const frozen = resolveRunFrozenSpec(db, runId);
    const def = frozen ? resolveWorkflowDefinition(frozen.workflowName, frozen.specJson) : null;
    return def
      ? def.phases.some((p) => p.steps.some((s) => s.id === stepId && s.fanOut !== undefined))
      : false;
  };

  // LIVE delivery for steer_step: when the steered step is executing RIGHT NOW,
  // interject the guidance into the running agent turn(s) via the SDK steering
  // queue (SubstrateDispatchFacade.injectSteering — a priority-'now' push into
  // the turn's live prompt input; the agent folds it in at its next loop
  // boundary). Which spawns count as "running this step":
  //   - the run-level agent (spawnKey === runId) when workflow_runs.
  //     current_step_id matches the steered step;
  //   - each RUNNING sprint lane whose lane pointer (sprint_batch_tasks.
  //     current_step_id) matches — fan-out lanes run INNER steps under spawnKey
  //     `${runId}:${taskId}`, and `taskRef` narrows delivery to ONE lane;
  //   - with `broadcastToLanes` (the steered id is an OUTER fan-out step, whose
  //     lane pointers hold INNER ids that can never equal it), EVERY running
  //     lane of the batch matches regardless of which inner step it is on.
  // Fail-soft: any error → 0 delivered (the stored next-spawn guidance is the
  // durable path); returns how many live agents actually accepted the push.
  const deliverLiveGuidance = (
    runId: string,
    stepId: string,
    guidance: string,
    taskRef?: string,
    broadcastToLanes?: boolean,
  ): number => {
    try {
      const live = new Set(substrateFacade.listLiveSpawnKeys(runId));
      if (live.size === 0) return 0;
      const row = db
        .prepare(
          `SELECT current_step_id AS currentStepId, batch_id AS batchId, project_id AS projectId
               FROM workflow_runs WHERE id = ?`,
        )
        .get(runId) as
        | { currentStepId: string | null; batchId: string | null; projectId: number | null }
        | undefined;
      if (!row) return 0;
      const targets: string[] = [];
      if (row.batchId) {
        let laneRows = broadcastToLanes
          ? (db
              .prepare(
                `SELECT task_id AS taskId FROM sprint_batch_tasks
                     WHERE batch_id = ? AND status = 'running'`,
              )
              .all(row.batchId) as Array<{ taskId: string }>)
          : (db
              .prepare(
                `SELECT task_id AS taskId FROM sprint_batch_tasks
                     WHERE batch_id = ? AND status = 'running' AND current_step_id = ?`,
              )
              .all(row.batchId, stepId) as Array<{ taskId: string }>);
        if (taskRef !== undefined) {
          // Ref-or-id resolution (mirrors taskMutationHandler.resolveTaskId):
          // an opaque id matches directly; a display ref resolves project-scoped.
          const resolved = db
            .prepare('SELECT id FROM tasks WHERE id = ? OR (project_id = ? AND ref = ?)')
            .get(taskRef, row.projectId, taskRef) as { id: string } | undefined;
          laneRows = resolved ? laneRows.filter((lane) => lane.taskId === resolved.id) : [];
        }
        targets.push(...laneRows.map((lane) => `${runId}:${lane.taskId}`));
      }
      // The run-level (non-lane) agent — only when the operator did NOT narrow
      // to a lane (taskRef targets lanes exclusively).
      if (taskRef === undefined && row.currentStepId === stepId) {
        targets.push(runId);
      }
      const text = `## Operator guidance (live)\n\nThe operator sent this guidance for the step you are executing RIGHT NOW — fold it into your current work:\n\n${guidance}`;
      let delivered = 0;
      for (const spawnKey of targets) {
        if (live.has(spawnKey) && substrateFacade.injectSteering(spawnKey, runId, text)) {
          delivered += 1;
        }
      }
      return delivered;
    } catch (err) {
      loggerLike.warn('[Main] steer_step live delivery failed (fail-soft)', {
        runId,
        stepId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  };

  // Rewind deps bag (monitor rewind_to_step): the SAME db / runQueues /
  // runExecutor / runStatusEvents as the retry bag, plus the abort seam
  // (substrateFacade.abort — pause/handover's stopLiveRun), the step_results
  // purge primitive, the fan-out lane counters, and the pending-gate sweep.
  // countRedispatchableLanes counts non-'integrated' lanes — exactly what a
  // re-entered fanOut step would dispatch after resetFailedLanes re-queues the
  // failed ones (the production driver's resolveItems filters integrated+failed;
  // failed lanes count here because the handler resets them before re-driving).
  const rewindRunDepsBag: RewindRunDeps = {
    db,
    runQueues,
    runExecutor,
    stopLiveRun: (runId) => substrateFacade.abort(runId),
    emitRunStatusChanged: (runId, status) => runStatusEvents.emit('changed', { runId, status }),
    listStepResults: (runId) => StepResultStore.tryGetInstance()?.listForRun(runId) ?? [],
    deleteStepResults: (runId, stepIds) =>
      StepResultStore.tryGetInstance()?.deleteForSteps(runId, stepIds) ?? 0,
    recordStepResult: (r) => StepResultStore.tryGetInstance()?.record(r),
    resetFailedLanes: (batchId) => SprintLaneStore.getInstance().resetFailedLanes(batchId),
    countRedispatchableLanes: (batchId) =>
      SprintLaneStore.getInstance()
        .listLanes(batchId)
        .filter((lane) => lane.status !== 'integrated').length,
    reopenBatch: (batchId) => SprintLaneStore.getInstance().reopenBatch(batchId),
    clearPendingGateItems: (runId) => HumanStepManager.getInstance().clearPendingForRun(runId),
    clearPendingApprovalsForRun: (runId) => {
      ApprovalRouter.getInstance().clearPendingForRun(runId);
    },
    clearPendingQuestionsForRun: (runId) => {
      QuestionRouter.getInstance().clearPendingForRun(runId);
    },
    logger: loggerLike,
  };
  // The review queue's "Address review findings" CTA (TASK-277) is a SECOND
  // entry point onto this SAME dep bag — rewindRunHandler(runId,
  // 'address-review', ...), wired here rather than duplicating the bag.
  setRewindRunDeps(rewindRunDepsBag);
  console.log('[Main] runs.addressReviewFindings deps wired');

  // Lane-rewind deps bag (monitor rewind_lane_to_step). Deliberately tiny next to
  // the rewind bag above: a lane rewind mutates nothing durable — it records an
  // in-memory directive and interrupts ONE lane — so it needs no queue, no
  // step_results purge, and no batch/lane writers. `abortLaneSpawn` is the SAME
  // facade abort the whole-run rewind uses as `stopLiveRun`, keyed here on the
  // PER-LANE spawn key (`${runId}:${taskId}`) the fan-out driver spawns under
  // rather than the run id, so exactly one lane's process dies.
  const laneRewindDepsBag: LaneRewindDeps = {
    db,
    requestLaneRewind: (runId, itemId, stepId) => runExecutor.requestLaneRewind(runId, itemId, stepId),
    listLiveSpawnKeys: (runId) => substrateFacade.listLiveSpawnKeys(runId),
    abortLaneSpawn: (spawnKey) => substrateFacade.abort(spawnKey),
    logger: loggerLike,
  };

  const monitorSteeringActions: MonitorSteeringActions = {
    addTask: (runId, input) => addTaskToRun(runId, input, taskMutationDeps).then(mapTaskResult),
    removeTask: (runId, input) => removeTaskFromRun(runId, input, taskMutationDeps).then(mapTaskResult),
    editTask: (runId, input) => editRunTask(runId, input, taskMutationDeps).then(mapTaskResult),
    skipStep: async (runId, input) => {
      const v = validateRunStep(runId, input.stepId);
      if (!v.ok) return { ok: false, message: v.message };
      runExecutor.addUserSkip(runId, input.stepId);
      return {
        ok: true,
        message: `Step '${input.stepId}' will be skipped when the run reaches it (no effect if it has already run).`,
      };
    },
    unskipStep: async (runId, input) => {
      const v = validateRunStep(runId, input.stepId);
      if (!v.ok) return { ok: false, message: v.message };
      runExecutor.removeUserSkip(runId, input.stepId);
      return { ok: true, message: `Cleared the pending skip on step '${input.stepId}'.` };
    },
    steerStep: async (runId, input) => {
      const v = validateRunStep(runId, input.stepId);
      if (!v.ok) return { ok: false, message: v.message };
      // An OUTER fan-out step never spawns its own agent while lanes exist and
      // its durable guidance is never re-read (the controller walks the
      // synthesized INNER chain; SpawnStepRunner resolves guidance by the inner
      // ids) — storing under it would be a silent no-op reported as success.
      // Treat it as a LIVE-ONLY broadcast to the running sprint agents instead,
      // and point the operator at the inner step ids for durable guidance.
      if (isOuterFanOutStep(runId, input.stepId)) {
        const delivered = deliverLiveGuidance(runId, input.stepId, input.guidance, input.taskRef, true);
        if (delivered > 0) {
          return {
            ok: true,
            message: `Delivered your guidance live to ${delivered} running sprint agent${delivered === 1 ? '' : 's'}. (Live-only: '${input.stepId}' is a fan-out phase, so nothing is stored — steer one of its inner steps, e.g. 'implement', to store guidance for future spawns.)`,
          };
        }
        return {
          ok: false,
          message: `No sprint agent is running right now, so there was nothing to steer live — and '${input.stepId}' is a fan-out phase whose stored guidance would never be read. Steer one of its inner steps (e.g. 'implement') to store guidance for future spawns.`,
        };
      }
      // taskRef narrows to ONE sprint lane's RUNNING agent — a live-only
      // delivery (RunDirectives.stepGuidance is keyed by stepId alone, so a
      // stored per-lane steer would leak to every lane's next spawn of that
      // step; refusing the store keeps the narrowing honest).
      if (input.taskRef !== undefined) {
        const delivered = deliverLiveGuidance(runId, input.stepId, input.guidance, input.taskRef);
        if (delivered > 0) {
          return {
            ok: true,
            message: `Delivered your guidance live to ${input.taskRef}'s agent on step '${input.stepId}'. (Live-only: it is not stored for future spawns — steer without taskRef for that.)`,
          };
        }
        return {
          ok: false,
          message: `${input.taskRef}'s agent isn't currently mid-flight on step '${input.stepId}', so there was nothing to steer live. Steer without taskRef to store guidance for every future spawn of the step.`,
        };
      }
      // Durable path FIRST: the guidance rides RunDirectives and is composed
      // into every FUTURE spawn of this step (including retries after a live
      // delivery — deliberate reinforcement, not duplication).
      runExecutor.setStepGuidance(runId, input.stepId, input.guidance);
      // Live path: when the step is executing right now, ALSO interject the
      // guidance mid-turn via the SDK steering queue.
      const delivered = deliverLiveGuidance(runId, input.stepId, input.guidance);
      const stored = `Added your guidance to step '${input.stepId}' — it'll be included whenever that step (re)spawns.`;
      return {
        ok: true,
        message:
          delivered > 0
            ? `${stored} Also delivered it live to ${delivered} agent${delivered === 1 ? '' : 's'} running that step right now.`
            : `${stored} No agent is mid-flight on that step right now, so it first lands at the next spawn.`,
      };
    },
    rewindToStep: async (runId, input) => {
      const result = await rewindRunHandler(runId, input.stepId, rewindRunDepsBag);
      if ('delivered' in result) {
        const abortNote = result.abortedLiveWalk ? ' Stopped the in-flight work first.' : '';
        const keptNote = result.fanOutKeptSettled
          ? ' Already-integrated sprint work stays settled — only the surrounding steps re-run.'
          : '';
        return {
          ok: true,
          message: `Rewound the run to step '${result.stepId}' — re-running from there now.${abortNote}${keptNote}`,
        };
      }
      const messages: Record<string, string> = {
        not_found: 'Run not found.',
        not_programmatic: 'Only programmatic runs can be rewound.',
        not_rewindable:
          "The run isn't in a rewindable state — it must be running, resting, failed, or paused.",
        unknown_step: `Step '${input.stepId}' is not one of this workflow's timeline steps — rewind targets the run's own steps, not a sprint task's inner steps.`,
        target_not_prior:
          "That step is ahead of the run's current position — rewind only goes backward. To jump forward, skip the steps in between instead.",
        fanout_settled:
          'Every sprint task in this run is already integrated — nothing would re-run at that fan-out step. Rewind to an earlier step instead, or add a task first.',
        race: 'The run changed state mid-rewind — try again.',
      };
      return { ok: false, message: messages[result.reason] ?? `Rewind refused (${result.reason}).` };
    },
    rewindLaneToStep: async (runId, input) => {
      const result = await laneRewindHandler(runId, input, laneRewindDepsBag);
      if ('delivered' in result) {
        // Distinguish the two interrupt paths in the message: a killed agent turn
        // is visible to the user (the lane's transcript stops mid-thought), while a
        // directive that lands at the lane's next step boundary is not.
        const stopNote = result.abortedSpawn
          ? " Stopped that lane's current agent first."
          : ' It takes effect as soon as the lane finishes what it is doing.';
        const fromNote = result.fromStepId !== null ? ` (was on '${result.fromStepId}')` : '';
        return {
          ok: true,
          message: `Rewound ${result.ref}'s lane to step '${result.stepId}'${fromNote} — only that lane re-runs; the rest of the sprint keeps going.${stopNote}`,
        };
      }
      const laneStatusHint =
        result.laneStatus === 'queued'
          ? "that lane hasn't started yet, so it will run from the top of its chain anyway"
          : result.laneStatus === 'integrated'
            ? 'that lane already finished and integrated — re-running it needs a whole-run rewind to the fan-out step'
            : `that lane has already settled (${result.laneStatus ?? 'unknown'}) — re-driving a settled lane needs a whole-run rewind or a retry`;
      const messages: Record<string, string> = {
        not_found: 'Run not found.',
        not_programmatic: 'Only programmatic runs have sprint lanes to rewind.',
        run_not_running:
          "The run isn't executing right now, so there is no live lane to rewind. Use retry or the whole-run rewind to revive it first.",
        no_fan_out: "This run has no sprint task fan-out, so there are no lanes to rewind.",
        unknown_task: `No task matching '${input.taskRef}' in this project.`,
        lane_not_found: `${input.taskRef} isn't one of this run's sprint lanes.`,
        lane_not_live: `Can't rewind ${input.taskRef}'s lane — ${laneStatusHint}.`,
        unknown_step: `'${input.stepId}' isn't one of this run's lane steps — a lane rewind targets a task's INNER steps (e.g. 'implement', 'code-review'), not the run's phase steps. Use the whole-run rewind for those.`,
        target_not_prior: `'${input.stepId}' is ahead of where that lane is now — a lane rewind only goes backward.`,
      };
      return { ok: false, message: messages[result.reason] ?? `Lane rewind refused (${result.reason}).` };
    },
    // The two review-queue actions (resolve_review_item / file_note) live in
    // ./monitorReviewQueueComposition.ts (issue #19 size ratchet) and reuse
    // this block's db / run→project lookup / logger.
    ...composeMonitorReviewQueueActions({ db, runProjectId, loggerLike }),
  };
  console.log('[Main] monitor steering actions wired');

  // Autonomous MONITOR-ACTION sinks (lane rescue, review-loop steering, gate
  // escalation). Built HERE, alongside the steering actions, so all of them
  // reuse the SAME `taskMutationDeps`, review-queue chokepoint and run→project
  // resolution those actions route through. Logic: monitorActionSinks.ts.
  const monitorActionSinkDeps: MonitorActionSinkDeps = {
    db,
    runProjectId,
    applyReviewItem: (projectId, change) =>
      ReviewItemRouter.getInstance().applyReviewItem(projectId, change),
    awaitProjectWritesSettled: (projectId) => ReviewItemRouter.getInstance().awaitProjectWritesSettled(projectId),
    taskMutations: taskMutationDeps,
    describeTaskFailure: (result) => mapTaskResult(result).message,
    logger: loggerLike,
  };
  const laneTriageActions = buildLaneTriageActions(monitorActionSinkDeps);
  const monitorFindingSink = buildMonitorFindingSink(monitorActionSinkDeps);
  const setAsideFindingSink = buildSetAsideFindingSink(monitorActionSinkDeps);
  const gateEscalationSinks = buildGateEscalationSinks(monitorActionSinkDeps);
  console.log('[Main] monitor action sinks wired');

  // Lazy monitor rehydration: after an app restart the in-process
  // MonitorRegistry is empty, and boot recovery only re-drives
  // starting/running/awaiting_review runs (re-registering their monitors as a
  // side effect) — a run already failed/paused/canceled/completed at boot
  // would keep a silently dead monitor chat. On a registry miss the monitor
  // router consults this rehydrator: it revives the session from the
  // workflow_runs row via the SAME construction closure the run used at start
  // (buildMonitorSession) and recreates the persisting inject bridge through
  // RunExecutor.ensureMonitorInjectBridge so converse turns still render into
  // the Chat pane and persist to raw_events. Refusal matrix (non-sdk,
  // non-programmatic, missing row/worktree) lives in monitorRehydration.ts.
  setMonitorRehydrator(
    createMonitorRehydrator({
      db,
      ensureInjectBridge: (runId) => runExecutor.ensureMonitorInjectBridge(runId),
      buildSession: (ctx, injectEvent) => {
        const buildMonitorSession = getBuildMonitorSession();
        if (!buildMonitorSession) {
          // Unreachable in practice: initializeServices() assigns the holder
          // before this wiring block runs; the router treats a throw as a miss.
          throw new Error('buildMonitorSession not initialized before rehydrator wiring');
        }
        return buildMonitorSession(ctx, injectEvent);
      },
      logger: loggerLike,
    }),
  );
  console.log('[Main] monitor lazy rehydrator wired');

  return {
    monitorRetryStep,
    monitorSwitchToOrchestrated,
    monitorSteeringActions,
    laneTriageActions,
    monitorFindingSink,
    setAsideFindingSink,
    gateEscalationSinks,
  };
}
