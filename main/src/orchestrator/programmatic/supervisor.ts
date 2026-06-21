/**
 * Supervisor plane for the programmatic execution model (Stage 3 — see
 * docs/sdk-program-driven-workflows.md).
 *
 * In the programmatic model host CODE walks the DAG (the WorkflowController, the
 * "execution plane"). The SUPERVISOR is the second plane: it does NOT sequence the
 * workflow — it MONITORS the walk, is the HUMAN SEAM, and TRIAGES issues. The
 * controller drives it through two host hooks (ControllerHost.notify +
 * triageFailure) so the supervisor is a pluggable collaborator behind a narrow,
 * fakeable interface:
 *
 *   - notify(event)        — the monitor feed (run/step lifecycle).
 *   - triage(step, error)  — consulted when a required step has exhausted its
 *                            retry/loopback budget: retry | escalate | fail.
 *
 * Two non-agent implementations ship here:
 *   - `NoopSupervisor`        — the byte-identical default: triage always 'fail'
 *                               (the Stages 1-2 behavior), monitor feed dropped.
 *   - `ReviewQueueSupervisor` — triage 'escalate': a failed required step is
 *                               routed to the HUMAN review queue (via the
 *                               controller's existing human-gate path) instead of
 *                               hard-failing the run. This is the smallest concrete
 *                               realization of "sub-agents/issues route to the
 *                               human seam" and needs no second agent session.
 *
 * The full SDK MONITOR/CHAT agent (a long-lived streaming-input `query()` session
 * the user can converse with, emitting triage verdicts via structured output)
 * slots into this SAME `SupervisorSession` interface; it is designed in the doc
 * and left as the live-deferred slice (it needs a distinct persistent session +
 * a renderer chat surface that cannot be headlessly verified — the same caveat as
 * the Stage 2 SDK step path).
 *
 * Standalone-typecheck invariant: shared types + sibling protocol types only.
 */
import type { WorkflowStep } from '../../../../shared/types/workflows';
import type { LoggerLike } from '../types';
import type { SupervisorEvent, TriageDecision } from './types';

/** Per-run context handed to the supervisor when the run starts. */
export interface SupervisorContext {
  runId: string;
  projectId: number;
  workflowName: string;
  /** The run's git worktree — the cwd a real SDK supervisor agent runs in. */
  worktreePath: string;
}

/** A triage request: the failed step + the last error it produced. */
export interface SupervisorTriageRequest {
  step: WorkflowStep;
  error: string | undefined;
}

/**
 * The supervisor a programmatic run runs alongside. `start`/`stop` bracket the
 * run (no-ops for the policy supervisors; spawn/teardown for the SDK agent).
 * `notify` is the fail-soft monitor feed. `triage` returns the decision for a
 * required step that exhausted its budget.
 */
export interface SupervisorSession {
  start(ctx: SupervisorContext): Promise<void>;
  notify(event: SupervisorEvent): void;
  triage(req: SupervisorTriageRequest): Promise<TriageDecision>;
  stop(): Promise<void>;
}

/**
 * The byte-identical default: no monitoring, and a required-step failure triages
 * to 'fail' — exactly the Stages 1-2 behavior. Wiring this keeps the triage seam
 * dormant-safe until a real supervisor is opted in.
 */
export class NoopSupervisor implements SupervisorSession {
  async start(): Promise<void> {
    /* no-op */
  }
  notify(): void {
    /* no-op */
  }
  async triage(): Promise<TriageDecision> {
    return 'fail';
  }
  async stop(): Promise<void> {
    /* no-op */
  }
}

/**
 * Routes a required-step failure to the HUMAN review queue instead of hard-failing
 * the run: triage returns 'escalate', so the controller opens a human gate for the
 * failed step (the human then approves=skip / revises=retry / rejects=fail /
 * aborts=cancel). The monitor feed is logged. No second agent session — this is
 * the policy realization of the human-seam routing; the SDK monitor/chat agent is
 * a drop-in replacement behind the same interface.
 */
export class ReviewQueueSupervisor implements SupervisorSession {
  constructor(private readonly logger?: LoggerLike) {}

  async start(ctx: SupervisorContext): Promise<void> {
    this.logger?.info('[ReviewQueueSupervisor] supervising programmatic run', {
      runId: ctx.runId,
      workflow: ctx.workflowName,
    });
  }

  notify(event: SupervisorEvent): void {
    // Monitor feed → structured log (the SDK agent would consume this instead).
    if (event.kind === 'step-failed' || event.kind === 'run-finished') {
      this.logger?.info(`[ReviewQueueSupervisor] ${event.kind}`, {
        runId: event.runId,
        stepId: event.stepId,
        outcome: event.outcome,
        error: event.error,
      });
    }
  }

  async triage(req: SupervisorTriageRequest): Promise<TriageDecision> {
    this.logger?.warn('[ReviewQueueSupervisor] escalating failed step to the human review queue', {
      stepId: req.step.id,
      error: req.error,
    });
    return 'escalate';
  }

  async stop(): Promise<void> {
    /* no live session to tear down */
  }
}
