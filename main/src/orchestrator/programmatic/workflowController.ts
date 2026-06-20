/**
 * WorkflowController — the host-side, deterministic DAG walker for the
 * `programmatic` execution model (Stage 1; see
 * docs/sdk-program-driven-workflows.md).
 *
 * This is the "code walks the DAG" engine. Given a `WorkflowDefinition` (the SAME
 * shared DAG the orchestrated model feeds to an agent), it sequences phases and
 * steps IN ORDER and owns every control-flow decision the orchestrated prose
 * otherwise asks the model to make:
 *
 *   - report each step boundary (running → done) to the live timeline,
 *   - run each non-human step's agent via the injected `StepRunner`,
 *   - honor the per-step `retries` budget (in-place re-attempts),
 *   - honor intra-phase `loopback` on exhaustion (bounded by MAX_STEP_LOOPBACKS),
 *   - skip `optional` steps that fail, escalate required steps that fail,
 *   - resolve human gates via the injected `ControllerHost.requestHumanGate`
 *     (approve advances, reject ends the run, revise loops back / re-presents).
 *
 * The controller is PURE with respect to its injected collaborators (StepRunner +
 * ControllerHost) — it performs no DB / IPC / SDK work itself — so it is
 * exhaustively unit-testable with fakes. The unverifiable live-SDK work lives
 * entirely behind `StepRunner`.
 *
 * Standalone-typecheck invariant: shared types + sibling protocol types only.
 */
import type { WorkflowDefinition, WorkflowStep } from '../../../../shared/types/workflows';
import { HUMAN_GATE_AGENT } from '../../../../shared/types/agentIdentity';
import type {
  ControllerHost,
  ControllerResult,
  StepReport,
  StepRunner,
} from './types';

/**
 * Maximum number of intra-phase loopback JUMPS allowed per step id across a whole
 * run, bounding both agent-step loopbacks and human-gate revises so a flapping
 * step or an indecisive reviewer can never spin forever. Distinct from a step's
 * in-place `retries` budget (which re-attempts the SAME step without jumping).
 */
export const MAX_STEP_LOOPBACKS = 5;

/** A step is a human gate when `human === true` OR its agent is the human gate. */
function isHumanGate(step: WorkflowStep): boolean {
  return step.human === true || step.agent === HUMAN_GATE_AGENT;
}

export class WorkflowController {
  constructor(
    private readonly runner: StepRunner,
    private readonly host: ControllerHost,
  ) {}

  /**
   * Walk `def` to a terminal result. Resolves with the outcome + the ordered
   * execution trace; it never throws for a normal step failure (that is an
   * 'failed'/'rejected' outcome), only for an internal invariant breach (the
   * safety bound below) which indicates a controller bug, not a workflow error.
   */
  async run(runId: string, def: WorkflowDefinition): Promise<ControllerResult> {
    const steps: StepReport[] = [];
    // Per-step-id loopback counters, shared across the whole run so a target that
    // is revisited from multiple failing steps still terminates.
    const loopbacks = new Map<string, number>();

    for (const phase of def.phases) {
      // Defensive termination bound: even with maximal retries + loopbacks the
      // walk of a single phase cannot legitimately exceed this many step
      // executions. Exceeding it means a logic bug — fail loud rather than hang.
      const maxExecutions =
        phase.steps.length * (MAX_STEP_LOOPBACKS + 1) * (this.maxRetries(phase.steps) + 2) + 1;
      let executions = 0;

      let i = 0;
      while (i < phase.steps.length) {
        if (++executions > maxExecutions) {
          throw new Error(
            `WorkflowController: phase '${phase.id}' exceeded the execution bound (${maxExecutions}) — possible loopback cycle`,
          );
        }

        const step = phase.steps[i];
        const baseCtx = { runId, phaseId: phase.id, stepIndex: i };
        this.host.reportStep(step.id, 'running');

        if (isHumanGate(step)) {
          const decision = await this.host.requestHumanGate(step, { ...baseCtx, attempt: 1 });
          if (decision === 'approve') {
            steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'done', attempts: 1 });
            this.host.reportStep(step.id, 'done');
            i += 1;
            continue;
          }
          if (decision === 'reject') {
            steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'rejected', attempts: 1 });
            this.host.reportStep(step.id, 'done');
            return { outcome: 'rejected', steps, failedStepId: step.id };
          }
          // 'revise' — loop back to the gate's intra-phase target (or re-present
          // the gate when it has none), bounded by the per-step loopback budget.
          const jumped = this.tryLoopback(step, phase.steps, loopbacks);
          steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'done', attempts: 1 });
          this.host.reportStep(step.id, 'done');
          if (jumped !== null) {
            i = jumped;
          }
          // No budget / no jump target ⇒ re-present the same gate (i unchanged).
          continue;
        }

        // Agent step: in-place retries up to (retries + 1) attempts.
        const maxAttempts = step.retries + 1;
        let attempt = 0;
        let lastError: string | undefined;
        let ok = false;
        while (attempt < maxAttempts) {
          attempt += 1;
          const result = await this.runner.runStep(step, { ...baseCtx, attempt });
          if (result.status === 'ok') {
            ok = true;
            break;
          }
          lastError = result.error;
        }

        if (ok) {
          steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'done', attempts: attempt });
          this.host.reportStep(step.id, 'done');
          i += 1;
          continue;
        }

        // Retries exhausted — try an intra-phase loopback before escalating.
        const jumped = this.tryLoopback(step, phase.steps, loopbacks);
        if (jumped !== null) {
          this.host.log?.('warn', `step '${step.id}' failed; looping back to '${phase.steps[jumped].id}'`);
          this.host.reportStep(step.id, 'done');
          i = jumped;
          continue;
        }

        if (step.optional === true) {
          steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'skipped', attempts: attempt, error: lastError });
          this.host.log?.('warn', `optional step '${step.id}' failed; skipping`);
          this.host.reportStep(step.id, 'done');
          i += 1;
          continue;
        }

        // Required step, no loopback budget left — escalate (terminal failure).
        steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'failed', attempts: attempt, error: lastError });
        this.host.reportStep(step.id, 'done');
        return { outcome: 'failed', steps, failedStepId: step.id };
      }
    }

    return { outcome: 'completed', steps };
  }

  /**
   * Resolve an intra-phase loopback for `step`: returns the index of the loopback
   * target within `phaseSteps` when the step declares a resolvable `loopback` AND
   * its per-step loopback budget (MAX_STEP_LOOPBACKS) is not yet exhausted, else
   * null. Increments the budget counter on a successful resolution.
   */
  private tryLoopback(
    step: WorkflowStep,
    phaseSteps: WorkflowStep[],
    loopbacks: Map<string, number>,
  ): number | null {
    if (step.loopback === undefined || step.loopback.length === 0) return null;
    const targetIndex = phaseSteps.findIndex((s) => s.id === step.loopback);
    if (targetIndex < 0) return null; // unresolved (validation should prevent this)

    const used = loopbacks.get(step.id) ?? 0;
    if (used >= MAX_STEP_LOOPBACKS) return null;
    loopbacks.set(step.id, used + 1);
    return targetIndex;
  }

  /** Largest `retries` value among a phase's steps (for the safety bound). */
  private maxRetries(phaseSteps: WorkflowStep[]): number {
    return phaseSteps.reduce((max, s) => Math.max(max, s.retries), 0);
  }
}
