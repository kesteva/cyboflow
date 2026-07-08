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
 * 'aborted' without spawning. A genuine (non-canceled) failure is additionally
 * classified via isSystemicStepError: when the error text signals an
 * environment-level condition (usage/session/rate limit, provider overload,
 * auth) the result is stamped `systemic: true` so the controller parks-and-waits
 * on that condition instead of burning the step's retry/optional/loopback budget.
 *
 * Constructed per-run by DefaultProgrammaticRunner with the run's panel/session/
 * worktree bound, then invoked once per step by the WorkflowController.
 */
import type { PermissionMode } from '../../../../shared/types/workflows';
import type { ClaudeSpawnerLike } from '../runExecutor';
import type { LoggerLike } from '../types';
import type { StepRunner, StepRunResult, ControllerStepContext } from './types';
import { composeStepPrompt } from './stepPrompt';
import { isSystemicStepError } from './systemicError';
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
   * Per-step operator-GUIDANCE resolver (RunDirectives live steering). Invoked
   * ONCE per `runStep` (NOT captured at construction), mirroring the
   * `agentPermissionMode` thunk pattern above, so guidance the operator adds
   * mid-run is honored on the step's NEXT spawn. Returns the guidance text for
   * this step id (appended to the composed prompt) or `undefined` (the thunk
   * absent OR returning undefined ⇒ no guidance section — byte-identical to the
   * no-guidance path). Wired by DefaultProgrammaticRunner to the run's
   * RunDirectives `stepGuidance` map.
   */
  stepGuidance?: (stepId: string) => string | undefined;
  /**
   * Per-step sprint TASK-SCOPE resolver (the `# Sprint tasks` body). Invoked ONCE
   * per `runStep` (NOT captured at construction), mirroring the `agentPermissionMode`
   * / `stepGuidance` thunks above, so the block is RE-RENDERED from the run's live
   * batch each step. This is load-bearing for mid-run `add_task`: a lane added
   * after run start is dispatched by the fan-out's wave-boundary re-resolution, and
   * re-rendering here means its title/body appear in the scope block the step agent
   * sees (a run-start snapshot would list only the original tasks, leaving the added
   * lane grounded by opaque id alone). Absent for non-sprint runs, or returning
   * undefined ⇒ no task block (output unchanged).
   */
  taskScope?: () => string | undefined;
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

    // Re-resolve any operator guidance for this step PER STEP (RunDirectives live
    // steering) — never captured at construction — so guidance added mid-run is
    // honored on this step's next spawn, exactly like agentPermissionMode below.
    const userGuidance = this.opts.stepGuidance?.(step.id);
    // Re-render the sprint task-scope block PER STEP (never captured at
    // construction) so a lane added mid-run is grounded with its real title/body
    // on its first dispatch, exactly like userGuidance/agentPermissionMode.
    const taskScope = this.opts.taskScope?.();
    const prompt = composeStepPrompt({
      step,
      workflowName: this.opts.workflowName,
      attempt: ctx.attempt,
      ...(ctx.item ? { item: ctx.item } : {}),
      ...(taskScope ? { taskScope } : {}),
      ...(userGuidance ? { userGuidance } : {}),
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
      // Stamp systemic:true when the error text is an environment-level condition
      // (usage/rate limit, overload, auth) so the controller parks-and-retries
      // rather than consuming this step's retry/optional/loopback/triage budget.
      return { status: 'failed', error, ...(isSystemicStepError(error) ? { systemic: true } : {}) };
    }
  }
}
