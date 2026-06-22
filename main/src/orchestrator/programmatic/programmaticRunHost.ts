/**
 * ProgrammaticRunHost — the `ControllerHost` implementation for a programmatic
 * run. It adapts the controller's side-effect needs onto cyboflow surfaces via
 * narrow injected collaborators (all fakeable in tests):
 *
 *   - reportStep      → `StepReporter.report(runId, stepId, status)`, which in
 *                       production drives `current_step_id` + the live timeline
 *                       through the same `buildStepTransitionEvent` path the
 *                       agent's `cyboflow_report_step` tool uses. Fail-soft.
 *   - requestHumanGate→ `HumanGateResolver.resolve(...)` (see humanGate.ts).
 *   - triageFailure   → the optional ON-DEMAND `MonitorSession` (the monitor-unify
 *                       refactor; supersedes the Stage 3 supervisor + supervisor-chat
 *                       planes). When a monitor is wired the host asks it to triage a
 *                       required step that exhausted its budget and INJECTS the
 *                       monitor's rationale into the run's unified Chat pane as an
 *                       assistant turn (via `injectEvent`). When NO monitor is wired
 *                       the host returns 'escalate' — every exhausted required failure
 *                       routes to the human review queue (the default, behavior-
 *                       identical to the old ReviewQueueSupervisor).
 *
 * There is NO continuous monitor feed: routine step progress stays in the stepper
 * (the reporter path), and the chat carries CONVERSATION + NOTABLE events only.
 *
 * Bound to one run (runId + projectId) when constructed by
 * DefaultProgrammaticRunner.
 */
import type { WorkflowStep } from '../../../../shared/types/workflows';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { LoggerLike } from '../types';
import type { ControllerHost, ControllerStepContext, FanOutDriver, HumanGateDecision, StepReport, TriageDecision } from './types';
import type { HumanGateResolver } from './humanGate';
import type { MonitorSession } from './monitor';
import { buildAssistantTextEvent } from './syntheticEvents';

/**
 * Drives a step boundary onto the live timeline (current_step_id + emit). In
 * production a thin adapter over `buildStepTransitionEvent`; in tests a spy.
 */
export interface StepReporter {
  report(runId: string, stepId: string, status: 'pending' | 'running' | 'done'): void;
}

export interface ProgrammaticRunHostArgs {
  runId: string;
  projectId: number;
  reporter: StepReporter;
  gate: HumanGateResolver;
  /**
   * The ON-DEMAND monitor (the monitor-unify refactor). When present, the host
   * routes `triageFailure` to `monitor.triage` (which reads the WHOLE run history
   * fresh + may inspect the worktree) and injects its rationale into the run's Chat
   * pane. Absent ⇒ `triageFailure` returns 'escalate' (the default review-queue
   * routing). The monitor is opt-in via config `programmaticSupervisor: 'sdk'`.
   */
  monitor?: MonitorSession;
  /**
   * Inject a synthetic event into the run's unified stream (monitor-unify seam).
   * Used to render the monitor's triage rationale as an assistant turn in the Chat
   * pane. Threaded from the run context (Slice B); a no-op when no persisting bridge
   * was wired, so the host can call it unconditionally.
   */
  injectEvent?: (event: ClaudeStreamEvent) => void;
  /**
   * Per-step result sink (migration 032). When present, the host persists each
   * settled step's StepReport (in production via StepResultStore.record) — backing
   * queryable per-step results + crash-safe resume. Absent ⇒ not recorded.
   */
  recordStepResult?: (runId: string, report: StepReport) => void;
  /**
   * Optional fan-out lane driver (sprint-lane backed). Exposed verbatim on the
   * host's `fanOut` getter so the WorkflowController can resolve a step's item set
   * + drive a lane per item. Present ONLY for a seeded sprint-style run (a
   * non-empty `batch_id`); absent ⇒ `host.fanOut` is undefined ⇒ the controller
   * never fans out (a `fanOut` step runs as a normal single agent step).
   */
  fanOutDriver?: FanOutDriver;
  logger?: LoggerLike;
}

export class ProgrammaticRunHost implements ControllerHost {
  constructor(private readonly args: ProgrammaticRunHostArgs) {}

  reportStep(stepId: string, status: 'running' | 'done'): void {
    try {
      this.args.reporter.report(this.args.runId, stepId, status);
    } catch (err) {
      // Fail-soft, mirroring RunExecutor.emitStep — a broken timeline emit must
      // never abort the walk.
      this.args.logger?.warn('[ProgrammaticRunHost] step report failed (fail-soft)', {
        runId: this.args.runId,
        stepId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async requestHumanGate(step: WorkflowStep, ctx: ControllerStepContext): Promise<HumanGateDecision> {
    return this.args.gate.resolve({
      runId: this.args.runId,
      projectId: this.args.projectId,
      step,
      signal: ctx.signal,
    });
  }

  /**
   * Triage seam → the ON-DEMAND monitor (the monitor-unify refactor). Consulted
   * when a REQUIRED step has exhausted its retry/loopback budget, BEFORE the
   * controller fails the run:
   *   - monitor present ⇒ ask `monitor.triage` (reads the whole history, may inspect
   *     the worktree), INJECT its rationale into the Chat pane as an assistant turn,
   *     and return the decision.
   *   - monitor absent  ⇒ return 'escalate' (route to the human review queue — the
   *     default, behavior-identical to the old ReviewQueueSupervisor).
   * Fail-soft: a throwing monitor/inject must never strand the run — default to
   * 'escalate' (DefaultMonitorSession itself already fails-soft to 'escalate', so
   * this catch is a belt-and-braces guard).
   */
  async triageFailure(
    step: WorkflowStep,
    ctx: ControllerStepContext,
    error: string | undefined,
  ): Promise<TriageDecision> {
    if (!this.args.monitor) return 'escalate';
    try {
      const { decision, rationale } = await this.args.monitor.triage(step, error, ctx.signal);
      this.injectMonitorTurn(`Triage — ${step.name}: ${decision}. ${rationale}`);
      return decision;
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] monitor.triage failed; escalating to human', {
        runId: this.args.runId,
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'escalate';
    }
  }

  /** Render a monitor turn into the run's Chat pane. Fail-soft — never abort the walk. */
  private injectMonitorTurn(text: string): void {
    if (!this.args.injectEvent) return;
    try {
      this.args.injectEvent(buildAssistantTextEvent(text));
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] monitor turn inject failed (fail-soft)', {
        runId: this.args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Per-step result sink (migration 032). Fail-soft — recording must not abort the walk. */
  recordStepResult(report: StepReport): void {
    if (!this.args.recordStepResult) return;
    try {
      this.args.recordStepResult(this.args.runId, report);
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] recordStepResult failed (fail-soft)', {
        runId: this.args.runId,
        stepId: report.stepId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Fan-out lane driver (sprint-lane backed). Wired only for seeded sprint-style
   * runs; `ControllerHost.fanOut` is optional so an absent driver (undefined) is a
   * valid "never fans out" host — the controller treats a `fanOut` step as a normal
   * single agent step.
   */
  get fanOut(): FanOutDriver | undefined {
    return this.args.fanOutDriver;
  }

  log(level: 'info' | 'warn', message: string): void {
    if (level === 'warn') this.args.logger?.warn(message);
    else this.args.logger?.info(message);
  }
}
