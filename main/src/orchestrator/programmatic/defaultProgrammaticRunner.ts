/**
 * DefaultProgrammaticRunner — the production `ProgrammaticRunner` (Stage 2) that
 * RunExecutor delegates a programmatic run to. It assembles the per-run engine:
 * resolve the run's DAG (the SAME `WorkflowDefinition` the orchestrated model
 * uses), build a SpawnStepRunner (scoped agent turns) + a ProgrammaticRunHost
 * (timeline + human gates), drive the WorkflowController, then map the terminal
 * outcome onto the spawn contract RunExecutor expects:
 *
 *   - 'completed' → resolve (the run rests in awaiting_review).
 *   - 'rejected'  → resolve (a human declined a gate — a terminal human decision,
 *                   NOT an execution failure; the run rests for the user).
 *   - 'failed'    → throw (RunExecutor marks the run failed, identical to a
 *                   thrown orchestrator turn).
 *
 * The stateless collaborators (spawner, reporter, gate) are injected once at the
 * composition root; per-run state is bound inside run().
 */
import { resolveWorkflowDefinition } from '../../../../shared/types/workflows';
import type { ClaudeSpawnerLike, ProgrammaticRunner, ProgrammaticRunContext } from '../runExecutor';
import type { LoggerLike } from '../types';
import { WorkflowController } from './workflowController';
import { SpawnStepRunner } from './spawnStepRunner';
import { ProgrammaticRunHost, type StepReporter } from './programmaticRunHost';
import type { HumanGateResolver } from './humanGate';
import { NoopSupervisor, type SupervisorSession } from './supervisor';

export interface DefaultProgrammaticRunnerDeps {
  spawner: ClaudeSpawnerLike;
  reporter: StepReporter;
  gate: HumanGateResolver;
  /**
   * Per-run supervisor factory (Stage 3). Called once per run to build the
   * monitor + triage + human-seam supervisor that runs ALONGSIDE the controller.
   * Defaults to NoopSupervisor (byte-identical: triage 'fail', no monitoring) so
   * an un-configured deployment behaves exactly as Stages 1-2.
   */
  supervisorFactory?: () => SupervisorSession;
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

    // Supervisor (Stage 3): monitor + triage + human seam, bracketing the walk.
    const supervisor = (this.deps.supervisorFactory ?? (() => new NoopSupervisor()))();
    await supervisor.start({
      runId: ctx.runId,
      projectId: ctx.run.project_id,
      workflowName: ctx.workflow.name,
      worktreePath: ctx.worktreePath,
    });

    const host = new ProgrammaticRunHost({
      runId: ctx.runId,
      projectId: ctx.run.project_id,
      reporter: this.deps.reporter,
      gate: this.deps.gate,
      supervisor,
      logger: this.deps.logger,
    });

    let result;
    try {
      result = await new WorkflowController(runner, host).run(ctx.runId, def, ctx.signal);
    } finally {
      // Always tear the supervisor down — fail-soft so a broken stop never masks
      // the run outcome (or a thrown failure below).
      try {
        await supervisor.stop();
      } catch (err) {
        this.deps.logger?.warn('[ProgrammaticRunner] supervisor.stop failed (fail-soft)', {
          runId: ctx.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
