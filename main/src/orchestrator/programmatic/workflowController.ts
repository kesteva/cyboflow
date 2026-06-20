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
  HumanGateDecision,
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

/**
 * A step is a PURE human gate (no agent work) when its agent is the dedicated
 * human-gate agent. A step that names a REAL agent AND also sets `human === true`
 * (e.g. the planner's `context` step) is an AGENT step WITH a trailing human
 * checkpoint, NOT a pure gate — the controller runs its agent first, then opens
 * the gate (see `run`). Keying the pure-gate test on the agent identity (not on
 * `human === true`) is the fix for the prior bug where such agent+gate steps had
 * their agent work silently skipped.
 */
function isPureHumanGate(step: WorkflowStep): boolean {
  return step.agent === HUMAN_GATE_AGENT;
}

/** Whether a (non-pure-gate) agent step also carries a trailing human checkpoint. */
function hasTrailingGate(step: WorkflowStep): boolean {
  return step.human === true && step.agent !== HUMAN_GATE_AGENT;
}

export class WorkflowController {
  constructor(
    private readonly runner: StepRunner,
    private readonly host: ControllerHost,
  ) {}

  /**
   * Walk `def` to a terminal result. Resolves with the outcome + the ordered
   * execution trace; it never throws for a normal step failure (that is a
   * 'failed'/'rejected'/'canceled' outcome), only for an internal invariant
   * breach (the safety bound below) which indicates a controller bug.
   *
   * `signal` (optional) cancels the walk: it is checked at the top of every step
   * iteration and threaded into each runStep + human gate, so a canceled run
   * stops promptly with a 'canceled' outcome instead of completing or retrying.
   */
  async run(runId: string, def: WorkflowDefinition, signal?: AbortSignal): Promise<ControllerResult> {
    const steps: StepReport[] = [];
    // Per-step-id loopback counters, shared across the whole run so a target that
    // is revisited from multiple failing steps still terminates. Gate-revise
    // re-presentations consume this SAME budget (even when the gate has no jump
    // target) so an indecisive reviewer can never spin forever.
    const loopbacks = new Map<string, number>();

    for (const phase of def.phases) {
      const n = phase.steps.length;
      // Defensive termination bound on step VISITS within this phase (one per
      // while-iteration; in-place retries live INSIDE an iteration and do not
      // count). Worst case: at most MAX_STEP_LOOPBACKS jumps PER step id (n step
      // ids ⇒ ≤ MAX_STEP_LOOPBACKS*n jumps), and each jump can re-walk up to n
      // steps before the next jump ⇒ ≤ (MAX_STEP_LOOPBACKS*n + 1)*n visits. The
      // prior formula was linear in n and tripped FALSELY when several steps each
      // looped back to an early step (super-linear re-traversal). Exceeding this
      // corrected bound means a real logic bug — fail loud rather than hang.
      const maxExecutions = (MAX_STEP_LOOPBACKS * n + 1) * n + n + 1;
      let executions = 0;

      let i = 0;
      while (i < n) {
        if (signal?.aborted) {
          return { outcome: 'canceled', steps, failedStepId: phase.steps[i]?.id };
        }
        if (++executions > maxExecutions) {
          throw new Error(
            `WorkflowController: phase '${phase.id}' exceeded the execution bound (${maxExecutions}) — possible loopback cycle`,
          );
        }

        const step = phase.steps[i];
        const baseCtx = { runId, phaseId: phase.id, stepIndex: i, signal };
        this.host.reportStep(step.id, 'running');

        // ── Pure human gate (no agent work) ──────────────────────────────────
        if (isPureHumanGate(step)) {
          const decision = await this.host.requestHumanGate(step, { ...baseCtx, attempt: 1 });
          const next = this.applyGateDecision(decision, step, phase, phase.steps, loopbacks, steps, i);
          if (next.terminal) return next.result;
          i = next.i;
          continue;
        }

        // ── Agent step (optionally with a trailing human checkpoint) ─────────
        // In-place retries up to (retries + 1) attempts.
        const maxAttempts = step.retries + 1;
        let attempt = 0;
        let lastError: string | undefined;
        let ok = false;
        let aborted = false;
        while (attempt < maxAttempts) {
          attempt += 1;
          const result = await this.runner.runStep(step, { ...baseCtx, attempt });
          if (result.status === 'ok') {
            ok = true;
            break;
          }
          if (result.status === 'aborted') {
            aborted = true;
            break;
          }
          lastError = result.error;
        }

        if (aborted || signal?.aborted) {
          steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'canceled', attempts: attempt });
          this.host.reportStep(step.id, 'done');
          return { outcome: 'canceled', steps, failedStepId: step.id };
        }

        if (ok) {
          // Agent succeeded. If the step ALSO carries a human checkpoint, open the
          // gate now (agent-then-gate); otherwise advance.
          if (hasTrailingGate(step)) {
            const decision = await this.host.requestHumanGate(step, { ...baseCtx, attempt });
            const next = this.applyGateDecision(decision, step, phase, phase.steps, loopbacks, steps, i, attempt);
            if (next.terminal) return next.result;
            i = next.i;
            continue;
          }
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
   * Apply a human-gate decision, mutating `steps` and returning either the next
   * step index to resume at or a terminal result. Shared by the pure-gate arm and
   * the agent-then-gate arm. `attempts` records how many gate presentations /
   * agent attempts preceded this decision.
   *
   * - 'approve' → record done, advance to i+1.
   * - 'reject'  → record rejected, terminal 'rejected'.
   * - 'abort'   → record canceled, terminal 'canceled' (run was canceled).
   * - 'revise'  → consume the per-step loopback budget and either jump to the
   *               gate's loopback target, re-present the gate / re-run the step
   *               (i unchanged), or — when the budget is exhausted — END the run
   *               GRACEFULLY as 'rejected' (NOT by tripping the defensive
   *               execution-bound throw, which was the prior behavior).
   */
  private applyGateDecision(
    decision: HumanGateDecision,
    step: WorkflowStep,
    phase: WorkflowDefinition['phases'][number],
    phaseSteps: WorkflowStep[],
    loopbacks: Map<string, number>,
    steps: StepReport[],
    i: number,
    attempts = 1,
  ): { terminal: true; result: ControllerResult } | { terminal: false; i: number } {
    if (decision === 'approve') {
      steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'done', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: false, i: i + 1 };
    }
    if (decision === 'reject') {
      steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'rejected', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: true, result: { outcome: 'rejected', steps, failedStepId: step.id } };
    }
    if (decision === 'abort') {
      steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'canceled', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: true, result: { outcome: 'canceled', steps, failedStepId: step.id } };
    }

    // 'revise' — consume one unit of the per-step budget regardless of whether a
    // jump target exists, so a no-target gate's re-presentations are bounded too.
    const used = loopbacks.get(step.id) ?? 0;
    if (used >= MAX_STEP_LOOPBACKS) {
      // Budget exhausted — end gracefully rather than letting the defensive
      // per-phase execution bound throw.
      this.host.log?.('warn', `gate '${step.id}' revised ${used} times; ending run (revise budget exhausted)`);
      steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'rejected', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: true, result: { outcome: 'rejected', steps, failedStepId: step.id } };
    }
    loopbacks.set(step.id, used + 1);

    const targetIndex =
      step.loopback !== undefined && step.loopback.length > 0
        ? phaseSteps.findIndex((s) => s.id === step.loopback)
        : -1;
    steps.push({ stepId: step.id, phaseId: phase.id, outcome: 'done', attempts });
    this.host.reportStep(step.id, 'done');
    // A resolvable target ⇒ jump there; otherwise re-present the gate / re-run the
    // step (i unchanged).
    return { terminal: false, i: targetIndex >= 0 ? targetIndex : i };
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
}
