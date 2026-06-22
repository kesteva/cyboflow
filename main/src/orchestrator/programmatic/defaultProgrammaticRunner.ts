/**
 * DefaultProgrammaticRunner — the production `ProgrammaticRunner` that RunExecutor
 * delegates a programmatic run to. It assembles the per-run engine: resolve the
 * run's DAG (the SAME `WorkflowDefinition` the orchestrated model uses), build a
 * SpawnStepRunner (scoped agent turns) + a ProgrammaticRunHost (timeline + human
 * gates + optional monitor triage), drive the WorkflowController, then map the
 * terminal outcome onto the spawn contract RunExecutor expects:
 *
 *   - 'completed' → resolve (the run rests in awaiting_review).
 *   - 'rejected'  → resolve (a human declined a gate — a terminal human decision,
 *                   NOT an execution failure; the run rests for the user).
 *   - 'failed'    → throw (RunExecutor marks the run failed, identical to a
 *                   thrown orchestrator turn).
 *
 * The monitor-unify refactor folds the old Stage 3 supervisor + supervisor-chat
 * planes into a single ON-DEMAND `MonitorSession` (opt-in via
 * `programmaticSupervisor: 'sdk'`). When a `monitorFactory` is provided the runner
 * builds the monitor for the run, registers it in `MonitorRegistry` (so the tRPC
 * layer / renderer can reach it for chat), and passes both the monitor and the run
 * context's `injectEvent` into the host so triage rationale renders in the run's
 * existing Chat pane. There is NO separate transcript store and NO continuous feed.
 *
 * The stateless collaborators (spawner, reporter, gate) are injected once at the
 * composition root; per-run state is bound inside run().
 */
import { resolveWorkflowDefinition } from '../../../../shared/types/workflows';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { ClaudeSpawnerLike, ProgrammaticRunner, ProgrammaticRunContext } from '../runExecutor';
import type { LoggerLike } from '../types';
import type { StepReport } from './types';
import { WorkflowController } from './workflowController';
import { SpawnStepRunner } from './spawnStepRunner';
import { ProgrammaticRunHost, type StepReporter } from './programmaticRunHost';
import type { HumanGateResolver } from './humanGate';
import { MonitorRegistry, type MonitorContext, type MonitorSession } from './monitor';

export interface DefaultProgrammaticRunnerDeps {
  spawner: ClaudeSpawnerLike;
  reporter: StepReporter;
  gate: HumanGateResolver;
  /**
   * Per-run monitor factory (the monitor-unify refactor). Called once per run to
   * build the ON-DEMAND monitor brain (triage + chat answer). When present the
   * monitor is registered in `MonitorRegistry` and wired into the host so a required
   * step's exhausted failure is triaged WITH full history and its rationale renders
   * in the run's Chat pane. Absent ⇒ no monitor: exhausted required failures
   * 'escalate' to the human review queue (the default, behavior-identical to the old
   * ReviewQueueSupervisor). Opt-in via config `programmaticSupervisor: 'sdk'`.
   *
   * The run context's `injectEvent` (Slice B) is threaded as the SECOND arg so the
   * built session OWNS its chat-inject capability (its `converse` renders the human
   * turn + the monitor's reply into the run's Chat pane — the tRPC `monitor.send`
   * seam, Slice E). The registry still stores the bare `MonitorSession`, so the
   * router reaches both `answer` and `converse` through one entry.
   */
  monitorFactory?: (
    ctx: MonitorContext,
    injectEvent: (event: ClaudeStreamEvent) => void,
  ) => MonitorSession;
  /**
   * Per-step result sink (migration 032). When present, each settled step is
   * persisted (in production via StepResultStore.record) for queryable results +
   * crash-safe resume. Absent ⇒ results live only in the returned trace.
   */
  stepResultRecorder?: (runId: string, report: StepReport) => void;
  logger?: LoggerLike;
}

export class DefaultProgrammaticRunner implements ProgrammaticRunner {
  constructor(private readonly deps: DefaultProgrammaticRunnerDeps) {}

  async run(ctx: ProgrammaticRunContext): Promise<void> {
    const def = resolveWorkflowDefinition(ctx.workflow.name, ctx.workflow.spec_json);
    if (!def) {
      throw new Error(
        `DefaultProgrammaticRunner: no resolvable workflow definition for run ${ctx.runId} (workflow '${ctx.workflow.name}')`,
      );
    }

    const runner = new SpawnStepRunner(
      this.deps.spawner,
      {
        panelId: ctx.panelId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        worktreePath: ctx.worktreePath,
        workflowName: ctx.workflow.name,
        agentPermissionMode: ctx.run.permission_mode_snapshot,
      },
      this.deps.logger,
    );

    // ON-DEMAND monitor (the monitor-unify refactor): when a factory is wired, build
    // the monitor for this run + register it so the tRPC/renderer can reach it for
    // chat. Absent ⇒ no monitor (the host escalates exhausted failures to the human
    // queue — the default review-queue behavior).
    const monitor = this.deps.monitorFactory?.(
      {
        runId: ctx.runId,
        projectId: ctx.run.project_id,
        workflowName: ctx.workflow.name,
        worktreePath: ctx.worktreePath,
      },
      ctx.injectEvent,
    );
    if (monitor) {
      MonitorRegistry.getInstance().register(ctx.runId, monitor);
    }

    const host = new ProgrammaticRunHost({
      runId: ctx.runId,
      projectId: ctx.run.project_id,
      reporter: this.deps.reporter,
      gate: this.deps.gate,
      ...(monitor ? { monitor } : {}),
      injectEvent: ctx.injectEvent,
      ...(this.deps.stepResultRecorder ? { recordStepResult: this.deps.stepResultRecorder } : {}),
      logger: this.deps.logger,
    });

    // NOTE: the monitor is intentionally NOT unregistered when the walk ends. The
    // on-demand brain has no live session to tear down (each query is one-shot), and
    // it must stay reachable AFTER the walk so the user can chat with it about a run
    // resting in awaiting_review (or sitting failed / canceled-but-kept). It is
    // unregistered + its inject plumbing disposed at TERMINAL close-out (merge /
    // createPr / dismiss) by the composition-root close-out wiring
    // (RunExecutor.disposeMonitorResources + MonitorRegistry.unregister).
    const result = await new WorkflowController(runner, host).run(
      ctx.runId,
      def,
      ctx.signal,
      ctx.resumeFromStepId,
      ctx.completedStepIds,
    );

    if (result.outcome === 'failed') {
      throw new Error(
        `DefaultProgrammaticRunner: run ${ctx.runId} failed at step '${result.failedStepId ?? '?'}'`,
      );
    }
    // 'canceled' resolves (NOT throws) — the cancel path owns the terminal DB
    // transition; RunExecutor.executeProgrammatic skips its 'drained' rest when
    // the signal aborted. 'completed' / 'rejected' also rest for the user.

    this.deps.logger?.info('[ProgrammaticRunner] programmatic run finished', {
      runId: ctx.runId,
      outcome: result.outcome,
      steps: result.steps.length,
    });
  }
}
