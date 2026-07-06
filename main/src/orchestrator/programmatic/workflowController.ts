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
import { SPRINT_BATCH_CAP } from '../../../../shared/types/sprintBatch';
import type {
  ControllerHost,
  ControllerResult,
  ControllerStepContext,
  HumanGateDecision,
  StepReport,
  StepRunner,
  SupervisorEvent,
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
   *
   * `resumeFromStepId` (optional, crash-safe resume) FAST-FORWARDS the walk to the
   * step with that id: all phases/steps BEFORE it are skipped (they already ran
   * before the restart — their effects are in git/the DB), and the walk resumes AT
   * that step (re-running it, which is safe: an interrupted agent step re-runs and
   * a gate re-attaches to its still-pending review item). An unknown id (e.g. the
   * workflow was edited) falls back to starting from the beginning.
   */
  async run(
    runId: string,
    def: WorkflowDefinition,
    signal?: AbortSignal,
    resumeFromStepId?: string,
    completedStepIds?: ReadonlySet<string>,
  ): Promise<ControllerResult> {
    const steps: StepReport[] = [];
    // Per-step-id loopback counters, shared across the whole run so a target that
    // is revisited from multiple failing steps still terminates. Gate-revise
    // re-presentations consume this SAME budget (even when the gate has no jump
    // target) so an indecisive reviewer can never spin forever.
    const loopbacks = new Map<string, number>();
    // Per-step-id triage-retry counters (Stage 3) — bounds 'retry' triage verdicts
    // and escalation-gate 'revise' re-runs so a flapping step can never spin.
    const triageRetries = new Map<string, number>();
    // Closing-stage gate (2026-06-22): set true when a fan-out step settles with
    // one or more incomplete/failed lanes (the sprint has blocked tasks). While
    // set, the walk skips every subsequent AUTOMATED step (e.g. sprint-verify,
    // code-review) and advances straight to the next human gate, which surfaces the
    // partial sprint — running the closing stages over an incomplete sprint is
    // wasteful and misleading. Cleared when a human-gated step is reached.
    let skipToHumanGate = false;

    // Resume target: skip every phase/step before resumeFromStepId.
    let resumePhaseIdx = -1;
    let resumeStepIdx = -1;
    if (resumeFromStepId !== undefined && resumeFromStepId.length > 0) {
      for (let p = 0; p < def.phases.length; p++) {
        const s = def.phases[p].steps.findIndex((st) => st.id === resumeFromStepId);
        if (s >= 0) {
          resumePhaseIdx = p;
          resumeStepIdx = s;
          break;
        }
      }
      if (resumePhaseIdx < 0) {
        this.host.log?.('warn', `resume step '${resumeFromStepId}' not in definition; starting from the beginning`);
      } else {
        this.host.log?.('info', `resuming run at step '${resumeFromStepId}'`);
      }
    }

    this.emit({ kind: 'run-started', runId });

    for (let phaseIdx = 0; phaseIdx < def.phases.length; phaseIdx++) {
      const phase = def.phases[phaseIdx];
      // Skip phases entirely before the resume phase (already executed pre-restart).
      if (resumePhaseIdx >= 0 && phaseIdx < resumePhaseIdx) continue;
      const n = phase.steps.length;
      // Defensive termination bound on step VISITS within this phase (one per
      // while-iteration; in-place retries live INSIDE an iteration and do not
      // count). Each step id has TWO independent non-advancing budgets, both
      // capped at MAX_STEP_LOOPBACKS: `loopbacks` (loopback jumps + pure/agent-gate
      // revises) and `triageRetries` (Stage 3 triage 'retry' + escalate-gate
      // 'revise'). So a step can be re-visited up to 2*MAX_STEP_LOOPBACKS times,
      // and each re-visit can re-walk up to n steps before the next ⇒
      // ≤ (2*MAX_STEP_LOOPBACKS*n + 1)*n visits. The bound MUST include BOTH
      // budgets or a step that both loops back AND triage-retries trips this
      // defensive throw falsely. Exceeding it means a real logic bug — fail loud.
      const maxExecutions = (2 * MAX_STEP_LOOPBACKS * n + 1) * n + n + 1;
      let executions = 0;

      // Resume: start at the resume step index in the resume phase, else 0.
      let i = resumePhaseIdx >= 0 && phaseIdx === resumePhaseIdx ? resumeStepIdx : 0;
      while (i < n) {
        if (signal?.aborted) {
          return this.finish({ outcome: 'canceled', steps, failedStepId: phase.steps[i]?.id }, runId);
        }
        if (++executions > maxExecutions) {
          // Emit the terminal monitor event before the loud throw so the
          // supervisor feed stays consistent on EVERY terminal path.
          this.emit({ kind: 'run-finished', runId, outcome: 'failed', stepId: phase.steps[i]?.id });
          throw new Error(
            `WorkflowController: phase '${phase.id}' exceeded the execution bound (${maxExecutions}) — possible loopback cycle`,
          );
        }

        const step = phase.steps[i];

        // Crash-safe resume: a step that INDIVIDUALLY completed before a restart
        // (persisted done/skipped) is skipped without re-running or re-reporting.
        if (completedStepIds?.has(step.id)) {
          i += 1;
          continue;
        }

        // Blocking-review-items checkpoint: park before starting this step if the
        // PREVIOUS step left a pending BLOCKING review item (e.g. a blocking finding
        // the agent recorded). The host parks the run awaiting_review and awaits the
        // item(s) clearing, then resumes — so the pipeline can't march past a defect
        // the human must clear. Absent host seam (tests / non-programmatic) ⇒ no
        // parking (fast no-op). A cancel while parked ends the walk 'canceled'.
        if (this.host.awaitBlockingReviewItems) {
          const gate = await this.host.awaitBlockingReviewItems(runId, signal);
          if (gate === 'canceled' || signal?.aborted) {
            return this.finish({ outcome: 'canceled', steps, failedStepId: step.id }, runId);
          }
        }

        // Closing-stage gate: the sprint has incomplete/blocked tasks (a fan-out
        // settled with failed lanes). Skip every subsequent AUTOMATED step and go
        // straight to the next human gate. A human-gated step (pure gate or an
        // agent step with a trailing checkpoint) is the stopping point — it clears
        // the flag so any steps AFTER the gate run normally once the human decides.
        if (skipToHumanGate) {
          if (isPureHumanGate(step) || hasTrailingGate(step)) {
            skipToHumanGate = false;
          } else {
            this.pushStep(steps, {
              stepId: step.id,
              phaseId: phase.id,
              outcome: 'skipped',
              attempts: 1,
              error: 'sprint has incomplete or blocked tasks — closing stage skipped',
            });
            this.host.reportStep(step.id, 'done');
            this.host.log?.(
              'warn',
              `skipping '${step.id}': sprint has incomplete/blocked tasks; advancing to the human gate`,
            );
            i += 1;
            continue;
          }
        }

        // ── Host-driven parallel fan-out (programmatic plane only) ───────────
        // A step that declares `fanOut` AND has an injected driver resolves a
        // runtime item set; when non-empty, the host walks each item through the
        // inner chain (driving a lane per item) instead of running the step once.
        // An EMPTY item set (or an absent driver) falls through to the normal
        // single agent-step path below — byte-identical to today.
        if (step.fanOut !== undefined && this.host.fanOut !== undefined) {
          // resolveItems may hit the DB (the production sprint driver SELECTs lanes).
          // A throw must NOT crash the walk — contain it and fall through to the
          // normal single agent-step path (degraded but safe), mirroring driveLane's
          // fail-soft contract. An empty result takes the same fall-through.
          let items: string[] = [];
          try {
            items = this.host.fanOut.resolveItems(runId, step.fanOut.over);
          } catch (err) {
            this.host.log?.(
              'warn',
              `fan-out resolveItems('${step.fanOut.over}') threw; running '${step.id}' as a single step: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (items.length > 0) {
            this.host.reportStep(step.id, 'running');
            const fanResult = await this.runFanOut(
              runId,
              step,
              { runId, phaseId: phase.id, stepIndex: i, signal },
              items,
              signal,
            );
            if (fanResult.terminal) {
              // Mark the outer step canceled in the trace before the terminal.
              this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'canceled', attempts: 1 });
              this.host.reportStep(step.id, 'done');
              return this.finish({ outcome: 'canceled', steps, failedStepId: step.id }, runId);
            }
            // One or more lanes failed ⇒ the sprint is incomplete. Gate the closing
            // stages: subsequent automated steps are skipped until the next human
            // gate (set here, honored at the top of the step loop).
            if (fanResult.incompleteCount > 0) {
              skipToHumanGate = true;
              this.host.log?.(
                'warn',
                `fan-out '${step.id}' settled with ${fanResult.incompleteCount} incomplete lane(s); gating the sprint's closing stages until the human gate`,
              );
            }
            // The fan-out settled. If the OUTER step also carries a trailing human
            // checkpoint, open the gate now (fan-out-then-gate) and route the
            // decision through the SAME applyGateDecision logic the normal agent
            // path uses (so approve advances, reject/abort terminate, and revise
            // honors the outer step's `loopback`). Otherwise advance. Not routing
            // here silently dropped a declared `human`/`loopback` on a fanOut step.
            if (hasTrailingGate(step)) {
              this.emit({ kind: 'gate-opened', runId, phaseId: phase.id, stepId: step.id });
              const decision = await this.host.requestHumanGate(step, {
                runId,
                phaseId: phase.id,
                stepIndex: i,
                signal,
                attempt: 1,
              });
              const next = this.applyGateDecision(decision, step, phase, phase.steps, loopbacks, steps, i);
              if (next.terminal) return this.finish(next.result, runId);
              i = next.i;
              continue;
            }
            this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'done', attempts: 1 });
            this.host.reportStep(step.id, 'done');
            i += 1;
            continue;
          }
          // No items resolved ⇒ fall through to the normal agent-step path.
        }

        const baseCtx = { runId, phaseId: phase.id, stepIndex: i, signal };
        this.host.reportStep(step.id, 'running');

        // ── Pure human gate (no agent work) ──────────────────────────────────
        if (isPureHumanGate(step)) {
          this.emit({ kind: 'gate-opened', runId, phaseId: phase.id, stepId: step.id });
          const decision = await this.host.requestHumanGate(step, { ...baseCtx, attempt: 1 });
          const next = this.applyGateDecision(decision, step, phase, phase.steps, loopbacks, steps, i);
          if (next.terminal) return this.finish(next.result, runId);
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
          this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'canceled', attempts: attempt });
          this.host.reportStep(step.id, 'done');
          return this.finish({ outcome: 'canceled', steps, failedStepId: step.id }, runId);
        }

        if (ok) {
          // Agent succeeded. If the step ALSO carries a human checkpoint, open the
          // gate now (agent-then-gate); otherwise advance.
          if (hasTrailingGate(step)) {
            this.emit({ kind: 'gate-opened', runId, phaseId: phase.id, stepId: step.id });
            const decision = await this.host.requestHumanGate(step, { ...baseCtx, attempt });
            const next = this.applyGateDecision(decision, step, phase, phase.steps, loopbacks, steps, i, attempt);
            if (next.terminal) return this.finish(next.result, runId);
            i = next.i;
            continue;
          }
          this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'done', attempts: attempt });
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
          this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'skipped', attempts: attempt, error: lastError });
          this.host.log?.('warn', `optional step '${step.id}' failed; skipping`);
          this.host.reportStep(step.id, 'done');
          i += 1;
          continue;
        }

        // Required step, no loopback budget left — consult the supervisor's triage
        // seam (Stage 3) before failing. Absent ⇒ a hard 'fail' (Stages 1-2).
        const triaged = await this.handleRequiredFailure(
          step, phase, baseCtx, lastError, steps, i, attempt, triageRetries,
        );
        if (triaged.terminal) return this.finish(triaged.result, runId);
        i = triaged.i;
        continue;
      }
    }

    return this.finish({ outcome: 'completed', steps }, runId);
  }

  /** Fail-soft monitor-feed emit to the supervisor (Stage 3). */
  private emit(event: SupervisorEvent): void {
    try {
      this.host.notify?.(event);
    } catch {
      // A broken monitor feed must never affect the walk.
    }
  }

  /**
   * Append a settled step to the trace AND persist it host-side (Stage 3,
   * migration 033). Centralizes every settle so per-step results are recorded as
   * they happen (powering crash-safe resume + queryable results). Fail-soft: a
   * broken recorder must never affect the walk.
   */
  private pushStep(steps: StepReport[], report: StepReport): void {
    steps.push(report);
    try {
      this.host.recordStepResult?.(report);
    } catch {
      // A broken result sink must never affect the walk.
    }
  }

  /** Emit run-finished then return the result (single terminal seam). */
  private finish(result: ControllerResult, runId: string): ControllerResult {
    this.emit({ kind: 'run-finished', runId, outcome: result.outcome, stepId: result.failedStepId });
    return result;
  }

  /**
   * Walk a `fanOut` outer step: drive ONE lane per resolved item through the
   * step's inner chain, with bounded parallelism. Each item's lane goes
   * `running` (at the first inner step) → one `currentStepId` update per inner
   * step → `integrated` (all inner steps succeeded) or `failed` (a required inner
   * step failed). Items run in WAVES of at most `SPRINT_BATCH_CAP` via
   * `Promise.all`; the abort signal is checked between waves AND per inner step,
   * so a canceled run returns a terminal 'canceled' promptly. Lane writes go
   * through the injected fail-soft `host.fanOut.driveLane` (never throws); the
   * controller itself performs NO DB/IPC.
   *
   * Returns `{ terminal: false }` when the whole item set settled (the caller
   * then marks the outer step done), or `{ terminal: true }` ONLY on cancellation
   * (the caller ends the run 'canceled'). A required inner-step failure on ONE
   * item marks THAT lane 'failed' and stops that item, but does NOT terminate the
   * fan-out — sibling items continue and the outer step still settles 'done'
   * (the holistic verify/review OUTER steps after the fanOut catch real defects).
   *
   * Scheduling is DAG-aware (2026-06-22): a task is dispatched only once all of its
   * in-scope blocking prerequisites have integrated (via `host.fanOut.dependencies`);
   * a task whose prerequisite failed is marked failed (blocked). When the driver
   * exposes no dependencies this degrades to flat cap-sized waves. Still a v1
   * simplification on two axes: NO same-file serialization within a wave, and inner
   * `loopback` is parsed/validated upstream but NOT re-driven here (both reserved for
   * a future revision).
   */
  private async runFanOut(
    runId: string,
    step: WorkflowStep,
    baseCtx: { runId: string; phaseId: string; stepIndex: number; signal?: AbortSignal },
    items: string[],
    signal: AbortSignal | undefined,
  ): Promise<{ terminal: boolean; incompleteCount: number }> {
    const fanOut = step.fanOut;
    const driver = this.host.fanOut;
    // Defensive: the caller only enters here with both present; narrow for TS.
    if (fanOut === undefined || driver === undefined) return { terminal: false, incompleteCount: 0 };

    const inner = fanOut.inner;
    const allowedStepIds: readonly string[] = inner.map((s) => s.id);

    /**
     * Walk ONE item through the inner chain. Fail-soft per inner step:
     *  - required inner failure (or abort) → mark the lane (failed) + stop;
     *  - optional inner failure → skip that inner step, continue the lane;
     *  - all inner steps ok → mark the lane 'integrated'.
     * Returns 'aborted' when the signal fired mid-walk so the wave can short out.
     */
    const driveItem = async (itemId: string): Promise<'done' | 'failed' | 'aborted'> => {
      driver.driveLane({
        runId,
        itemId,
        status: 'running',
        currentStepId: inner[0].id,
        allowedStepIds,
      });

      for (let k = 0; k < inner.length; k++) {
        if (signal?.aborted) return 'aborted';
        const innerStep = inner[k];
        driver.driveLane({ runId, itemId, currentStepId: innerStep.id, allowedStepIds });

        // Synthesize a minimal WorkflowStep for the inner step + thread item
        // context so the spawner scopes the agent to THIS item.
        const synthesized: WorkflowStep = {
          id: innerStep.id,
          name: innerStep.name ?? innerStep.id,
          agent: innerStep.agent,
          mcps: [],
          retries: 0,
          ...(innerStep.optional !== undefined ? { optional: innerStep.optional } : {}),
        };
        const ctx: ControllerStepContext = {
          ...baseCtx,
          attempt: 1,
          item: { id: itemId, over: fanOut.over },
          // Additive per-lane spawn identity so concurrent lanes each spawn
          // under a distinct key instead of serializing on the shared run
          // panelId (which deadlocks waiting lanes on the spawn mutex).
          spawnKey: `${runId}:${itemId}`,
        };
        const result = await this.runner.runStep(synthesized, ctx);

        if (result.status === 'aborted') return 'aborted';
        if (result.status === 'failed') {
          if (innerStep.optional === true) {
            this.host.log?.('warn', `fan-out item '${itemId}': optional step '${innerStep.id}' failed; skipping`);
            continue;
          }
          driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
          this.host.log?.('warn', `fan-out item '${itemId}': step '${innerStep.id}' failed; lane failed`);
          return 'failed';
        }
      }

      driver.driveLane({ runId, itemId, status: 'integrated', allowedStepIds });
      return 'done';
    };

    // DAG-aware wave scheduling: dispatch a task only once ALL of its in-scope
    // blocking prerequisites have INTEGRATED. A task whose prerequisite FAILED can
    // never satisfy its preconditions, so its lane is marked failed (blocked) and
    // counts as incomplete. When the driver exposes no dependencies (or an empty
    // map) every task is ready immediately, so this degrades to flat cap-sized waves
    // — byte-identical to the pre-DAG behavior for non-dependency fan-outs.
    // Prerequisites are restricted to the in-scope item set; an out-of-scope prereq
    // (e.g. a task already integrated in a prior run and excluded from `items`) is
    // treated as satisfied.
    const inScope = new Set(items);
    let rawDeps: Map<string, string[]> | undefined;
    try {
      rawDeps = driver.dependencies?.(runId, fanOut.over);
    } catch (err) {
      this.host.log?.(
        'warn',
        `fan-out dependencies('${fanOut.over}') threw; running without DAG ordering: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const prereqs = new Map<string, string[]>();
    for (const itemId of items) {
      prereqs.set(itemId, (rawDeps?.get(itemId) ?? []).filter((p) => inScope.has(p) && p !== itemId));
    }

    const integrated = new Set<string>();
    const failed = new Set<string>();
    const remaining = new Set(items);
    let incompleteCount = 0;

    /** Mark a lane failed (a blocked/unrunnable task) and count it incomplete. */
    const markBlocked = (itemId: string, reason: string): void => {
      driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
      this.host.log?.('warn', `fan-out item '${itemId}': ${reason}; lane failed`);
      remaining.delete(itemId);
      failed.add(itemId);
      incompleteCount += 1;
    };

    while (remaining.size > 0) {
      if (signal?.aborted) return { terminal: true, incompleteCount };

      const ready: string[] = [];
      let blockedThisPass = false;
      for (const itemId of remaining) {
        const ps = prereqs.get(itemId) ?? [];
        if (ps.some((p) => failed.has(p))) {
          markBlocked(itemId, 'a blocking prerequisite failed');
          blockedThisPass = true;
        } else if (ps.every((p) => integrated.has(p))) {
          ready.push(itemId);
        }
        // else: still waiting on a pending prerequisite.
      }

      if (ready.length === 0) {
        if (blockedThisPass) continue; // made progress — re-evaluate readiness
        // Nothing ready and nothing newly blocked, yet items remain ⇒ their
        // prerequisites are unresolvable (a cycle, or a prereq that never runs).
        // Fail them rather than spin forever.
        for (const itemId of [...remaining]) {
          markBlocked(itemId, 'unresolvable blocking dependencies (cycle?)');
        }
        break;
      }

      // Dispatch ONE cap-sized wave of ready tasks concurrently, then re-evaluate
      // (tasks unblocked by this wave's integrations join the next wave).
      const wave = ready.slice(0, SPRINT_BATCH_CAP);
      const outcomes = await Promise.all(wave.map((itemId) => driveItem(itemId)));
      if (outcomes.includes('aborted') || signal?.aborted) return { terminal: true, incompleteCount };
      wave.forEach((itemId, idx) => {
        remaining.delete(itemId);
        if (outcomes[idx] === 'failed') {
          failed.add(itemId);
          incompleteCount += 1;
        } else {
          integrated.add(itemId);
        }
      });
    }

    return { terminal: false, incompleteCount };
  }

  /**
   * Handle a required step that exhausted its retry + loopback budget (Stage 3
   * triage seam). Notifies the supervisor of the failure, then consults
   * `host.triageFailure` (absent ⇒ 'fail'):
   *   - 'retry'    — re-run the step (i unchanged), bounded by a per-step triage
   *                  budget; budget-exhausted falls through to fail.
   *   - 'escalate' — open a human gate routing the failure to the review queue:
   *                    approve → skip the step and advance (the human accepts it),
   *                    revise  → retry the step (bounded), abort → cancel,
   *                    reject  → fail.
   *   - 'fail'     — terminal failure (also the no-advisor default).
   */
  private async handleRequiredFailure(
    step: WorkflowStep,
    phase: WorkflowDefinition['phases'][number],
    baseCtx: { runId: string; phaseId: string; stepIndex: number; signal?: AbortSignal },
    lastError: string | undefined,
    steps: StepReport[],
    i: number,
    attempt: number,
    triageRetries: Map<string, number>,
  ): Promise<{ terminal: true; result: ControllerResult } | { terminal: false; i: number }> {
    this.emit({ kind: 'step-failed', runId: baseCtx.runId, phaseId: phase.id, stepId: step.id, error: lastError });

    const ctx: ControllerStepContext = { ...baseCtx, attempt };
    const decision = this.host.triageFailure ? await this.host.triageFailure(step, ctx, lastError) : 'fail';

    const tryTriageRetry = (): { terminal: false; i: number } | null => {
      const used = triageRetries.get(step.id) ?? 0;
      if (used >= MAX_STEP_LOOPBACKS) return null;
      triageRetries.set(step.id, used + 1);
      this.host.reportStep(step.id, 'done');
      return { terminal: false, i };
    };

    if (decision === 'retry') {
      const retry = tryTriageRetry();
      if (retry) {
        this.host.log?.('warn', `triage: retrying failed step '${step.id}'`);
        return retry;
      }
      // budget exhausted → fall through to terminal failure
    } else if (decision === 'escalate') {
      this.emit({ kind: 'gate-opened', runId: baseCtx.runId, phaseId: phase.id, stepId: step.id });
      const verdict = await this.host.requestHumanGate(step, ctx);
      if (verdict === 'approve') {
        // The human accepts the failure — skip the step and advance.
        this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'skipped', attempts: attempt, error: lastError });
        this.host.log?.('warn', `triage: human accepted failure of step '${step.id}'; skipping`);
        this.host.reportStep(step.id, 'done');
        return { terminal: false, i: i + 1 };
      }
      if (verdict === 'abort') {
        this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'canceled', attempts: attempt });
        this.host.reportStep(step.id, 'done');
        return { terminal: true, result: { outcome: 'canceled', steps, failedStepId: step.id } };
      }
      if (verdict === 'revise') {
        const retry = tryTriageRetry();
        if (retry) return retry;
        // budget exhausted → fall through to terminal failure
      }
      // 'reject' (or revise-exhausted) → terminal failure
    }

    this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'failed', attempts: attempt, error: lastError });
    this.host.reportStep(step.id, 'done');
    return { terminal: true, result: { outcome: 'failed', steps, failedStepId: step.id } };
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
      this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'done', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: false, i: i + 1 };
    }
    if (decision === 'reject') {
      this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'rejected', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: true, result: { outcome: 'rejected', steps, failedStepId: step.id } };
    }
    if (decision === 'abort') {
      this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'canceled', attempts });
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
      this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'rejected', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: true, result: { outcome: 'rejected', steps, failedStepId: step.id } };
    }
    loopbacks.set(step.id, used + 1);

    const targetIndex =
      step.loopback !== undefined && step.loopback.length > 0
        ? phaseSteps.findIndex((s) => s.id === step.loopback)
        : -1;
    this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'done', attempts });
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
