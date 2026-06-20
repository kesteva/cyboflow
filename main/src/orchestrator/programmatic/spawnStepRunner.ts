/**
 * SpawnStepRunner — the SDK-backed `StepRunner` (Stage 2). Runs one workflow
 * step as a scoped agent turn via the existing spawn surface
 * (`ClaudeSpawnerLike.spawnCliProcess`, in production the SubstrateDispatchFacade
 * → ClaudeCodeManager). `spawnCliProcess` resolves when the agent's turn drains
 * cleanly (⇒ step ok) and rejects when the turn errors/aborts (⇒ step failed),
 * so the run mapping is a thin try/catch. Reusing the existing spawn path means
 * the run's MCP servers, agent overlay, worktree, and permission mode are all set
 * up exactly as for an orchestrated turn — only the prompt is narrowed to one
 * step (see composeStepPrompt).
 *
 * Constructed per-run by DefaultProgrammaticRunner with the run's panel/session/
 * worktree bound, then invoked once per step by the WorkflowController.
 */
import type { PermissionMode } from '../../../../shared/types/workflows';
import type { ClaudeSpawnerLike } from '../runExecutor';
import type { LoggerLike } from '../types';
import type { StepRunner, StepRunResult, ControllerStepContext } from './types';
import { composeStepPrompt } from './stepPrompt';
import type { WorkflowStep } from '../../../../shared/types/workflows';

/** Per-run spawn parameters bound when the runner is constructed. */
export interface SpawnStepRunnerOptions {
  panelId: string;
  sessionId: string;
  runId: string;
  worktreePath: string;
  workflowName: string;
  agentPermissionMode?: PermissionMode;
}

export class SpawnStepRunner implements StepRunner {
  constructor(
    private readonly spawner: ClaudeSpawnerLike,
    private readonly opts: SpawnStepRunnerOptions,
    private readonly logger?: LoggerLike,
  ) {}

  async runStep(step: WorkflowStep, ctx: ControllerStepContext): Promise<StepRunResult> {
    const prompt = composeStepPrompt({ step, workflowName: this.opts.workflowName, attempt: ctx.attempt });
    try {
      await this.spawner.spawnCliProcess({
        panelId: this.opts.panelId,
        sessionId: this.opts.sessionId,
        runId: this.opts.runId,
        worktreePath: this.opts.worktreePath,
        prompt,
        ...(this.opts.agentPermissionMode ? { agentPermissionMode: this.opts.agentPermissionMode } : {}),
      });
      return { status: 'ok' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[SpawnStepRunner] step '${step.id}' attempt ${ctx.attempt} failed`, {
        runId: this.opts.runId,
        stepId: step.id,
        error,
      });
      return { status: 'failed', error };
    }
  }
}
