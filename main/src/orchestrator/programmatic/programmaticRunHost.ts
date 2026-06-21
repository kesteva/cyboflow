/**
 * ProgrammaticRunHost — the `ControllerHost` implementation for a programmatic
 * run (Stage 2). It adapts the controller's two side-effect needs onto cyboflow
 * surfaces via narrow injected collaborators (both fakeable in tests):
 *
 *   - reportStep      → `StepReporter.report(runId, stepId, status)`, which in
 *                       production drives `current_step_id` + the live timeline
 *                       through the same `buildStepTransitionEvent` path the
 *                       agent's `cyboflow_report_step` tool uses. Fail-soft.
 *   - requestHumanGate→ `HumanGateResolver.resolve(...)` (see humanGate.ts).
 *
 * Bound to one run (runId + projectId) when constructed by
 * DefaultProgrammaticRunner.
 */
import type { WorkflowStep } from '../../../../shared/types/workflows';
import type { LoggerLike } from '../types';
import type { ControllerHost, ControllerStepContext, HumanGateDecision, StepReport, SupervisorEvent, TriageDecision } from './types';
import type { HumanGateResolver } from './humanGate';
import type { SupervisorSession } from './supervisor';
import type { SupervisorChatSession } from './supervisorChat';

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
   * The supervisor (Stage 3). When present, the host forwards the monitor feed to
   * `supervisor.notify` and routes triageFailure to `supervisor.triage`. Absent ⇒
   * the controller never sees notify/triageFailure (Stages 1-2 behavior).
   */
  supervisor?: SupervisorSession;
  /**
   * The supervisor CHAT session (Stage 3 human seam). When present, the host also
   * forwards the monitor feed to `chat.observe` so the conversational supervisor
   * stays aware of the run. Independent of `supervisor` (triage).
   */
  chat?: SupervisorChatSession;
  /**
   * Per-step result sink (Stage 3, migration 032). When present, the host persists
   * each settled step's StepReport (in production via StepResultStore.record) —
   * backing queryable per-step results + crash-safe resume. Absent ⇒ not recorded.
   */
  recordStepResult?: (runId: string, report: StepReport) => void;
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

  /** Monitor feed → supervisor + chat (Stage 3). Fail-soft — never abort the walk. */
  notify(event: SupervisorEvent): void {
    if (this.args.supervisor) {
      try {
        this.args.supervisor.notify(event);
      } catch (err) {
        this.args.logger?.warn('[ProgrammaticRunHost] supervisor.notify failed (fail-soft)', {
          runId: this.args.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (this.args.chat) {
      try {
        this.args.chat.observe(event);
      } catch (err) {
        this.args.logger?.warn('[ProgrammaticRunHost] chat.observe failed (fail-soft)', {
          runId: this.args.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Triage seam → supervisor (Stage 3). Returns 'fail' when no supervisor is wired
   * (Stages 1-2 behavior) or when the supervisor's triage itself throws (fail-soft
   * — a broken supervisor must never strand the run in a non-terminal state).
   */
  async triageFailure(
    step: WorkflowStep,
    _ctx: ControllerStepContext,
    error: string | undefined,
  ): Promise<TriageDecision> {
    if (!this.args.supervisor) return 'fail';
    try {
      return await this.args.supervisor.triage({ step, error });
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] supervisor.triage failed; defaulting to fail', {
        runId: this.args.runId,
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'fail';
    }
  }

  /** Per-step result sink (Stage 3). Fail-soft — recording must not abort the walk. */
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

  log(level: 'info' | 'warn', message: string): void {
    if (level === 'warn') this.args.logger?.warn(message);
    else this.args.logger?.info(message);
  }
}
