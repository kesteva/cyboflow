/**
 * SpawnStepRunner — the SDK-backed `StepRunner` (Stage 2). Runs one workflow
 * step as a scoped agent turn via the existing spawn surface
 * (`ClaudeSpawnerLike.spawnCliProcess`, in production the SubstrateDispatchFacade
 * → ClaudeCodeManager). `spawnCliProcess` resolves when the agent's turn drains
 * cleanly (⇒ step ok) and rejects when the turn errors (⇒ step failed), so the
 * run mapping is a thin try/catch. Reusing the existing spawn path means the
 * run's MCP servers, agent overlay, worktree, and permission mode are all set up
 * exactly as for an orchestrated turn — only the prompt is narrowed to one step
 * (see composeStepPrompt).
 *
 * CANCELLATION: the SDK substrate treats an aborted query() as a CLEAN exit, so a
 * canceled turn RESOLVES spawnCliProcess (it does NOT reject). Inferring success
 * purely from a resolved promise would therefore misread a cancel as 'ok' and let
 * the controller keep walking. So after the spawn settles we consult the injected
 * AbortSignal: if it fired, the result is 'aborted' (the controller ends the walk
 * with a 'canceled' outcome) — distinct from a genuine 'failed' turn that retries
 * / loops back. A signal already aborted BEFORE the spawn short-circuits to
 * 'aborted' without spawning.
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
  /**
   * Per-step agent-permission-mode RESOLVER (permission-mode redesign §3c#2).
   * Invoked ONCE per `runStep` (NOT captured at construction) so each step turn
   * spawns under the mode resolved at step time rather than a value frozen when
   * the runner was built — the session is the live execution authority.
   * `undefined` (the thunk absent OR returning undefined) ⇒ no override threaded
   * to the spawn (byte-identical to the no-mode path).
   */
  agentPermissionMode?: () => PermissionMode | undefined;
  /**
   * The sprint's task-scope block (the `# Sprint tasks` body), resolved once per
   * run by DefaultProgrammaticRunner from the run's batch_id. Threaded into EVERY
   * step prompt (each step is a fresh SDK session with no memory of prior steps),
   * so a sprint step agent always sees the real task set instead of hunting on
   * disk. Absent for non-sprint runs ⇒ no task block (output unchanged).
   */
  taskScope?: string;
}

export class SpawnStepRunner implements StepRunner {
  constructor(
    private readonly spawner: ClaudeSpawnerLike,
    private readonly opts: SpawnStepRunnerOptions,
    private readonly logger?: LoggerLike,
  ) {}

  async runStep(step: WorkflowStep, ctx: ControllerStepContext): Promise<StepRunResult> {
    // Already canceled before we even spawn — short-circuit.
    if (ctx.signal?.aborted) return { status: 'aborted' };

    const prompt = composeStepPrompt({
      step,
      workflowName: this.opts.workflowName,
      attempt: ctx.attempt,
      ...(ctx.item ? { item: ctx.item } : {}),
      ...(this.opts.taskScope ? { taskScope: this.opts.taskScope } : {}),
    });
    // Re-resolve the agent permission mode PER STEP (permission-mode redesign
    // §3c#2) — never captured at construction — so a mid-run mode change is
    // honored on the next step turn.
    const agentPermissionMode = this.opts.agentPermissionMode?.();
    try {
      await this.spawner.spawnCliProcess({
        panelId: this.opts.panelId,
        sessionId: this.opts.sessionId,
        runId: this.opts.runId,
        worktreePath: this.opts.worktreePath,
        prompt,
        ...(agentPermissionMode ? { agentPermissionMode } : {}),
        // Additive per-lane spawn identity — forwarded ONLY when present so the
        // non-fan-out (no-item) case stays byte-identical; the spawner defaults
        // spawnKey to panelId when absent.
        ...(ctx.spawnKey ? { spawnKey: ctx.spawnKey } : {}),
      });
      // The SDK treats an aborted turn as a clean drain, so a resolved spawn after
      // a cancel is NOT a real success — consult the signal to tell them apart.
      if (ctx.signal?.aborted) return { status: 'aborted' };
      return { status: 'ok' };
    } catch (err) {
      // A rejection during/after a cancel is the cancel, not a genuine failure.
      if (ctx.signal?.aborted) return { status: 'aborted' };
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
