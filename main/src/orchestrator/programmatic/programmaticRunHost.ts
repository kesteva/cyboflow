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
import type { ControllerHost, ControllerStepContext, HumanGateDecision } from './types';
import type { HumanGateResolver } from './humanGate';

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

  log(level: 'info' | 'warn', message: string): void {
    if (level === 'warn') this.args.logger?.warn(message);
    else this.args.logger?.info(message);
  }
}
