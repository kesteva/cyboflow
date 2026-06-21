/**
 * SDK supervisor — the "triage brain" slice of the Stage 3 supervisory plane
 * (see docs/sdk-program-driven-workflows.md). Where `ReviewQueueSupervisor`
 * blindly escalates EVERY failure to the human queue, `SdkSupervisorSession` asks
 * a real agent to TRIAGE a failed step — analyze it against the accumulated
 * monitor feed and decide retry / escalate / fail — embodying the user's "triage
 * any issues between agents" role.
 *
 * The SDK call is isolated behind a narrow, fakeable boundary:
 *   - `SupervisorAdvisor.advise(req)` — the triage decision surface (fakeable in
 *     tests; in production `SdkSupervisorAdvisor` over a `StructuredQueryFn`).
 *   - `StructuredQueryFn` — a one-shot structured SDK query (request/response via
 *     the SDK's native `outputFormat`). The ONLY real SDK call lives in
 *     `sdkStructuredQuery.ts` (the sole SDK importer); everything here is pure /
 *     fakeable and exhaustively unit-testable.
 *
 * Like the Stage 2 SDK step path, the LIVE SDK call cannot be exercised headlessly
 * — it is opt-in (config `programmaticSupervisor: 'sdk'`; default stays
 * `ReviewQueueSupervisor`) so the risk is contained.
 *
 * Standalone-typecheck invariant: shared types + sibling protocol types only — NO
 * `@anthropic-ai/claude-agent-sdk` import here (that lives in sdkStructuredQuery.ts).
 */
import type { WorkflowStep } from '../../../../shared/types/workflows';
import type { LoggerLike } from '../types';
import type { SupervisorEvent, TriageDecision } from './types';
import type { SupervisorContext, SupervisorSession, SupervisorTriageRequest } from './supervisor';

/** Bounded context handed to the advisor: the failure + recent monitor events. */
export interface SupervisorAdviceRequest {
  workflowName: string;
  failedStep: { id: string; name: string; agent: string };
  error: string | undefined;
  /** Most-recent-first window of monitor events for situational context. */
  recentEvents: SupervisorEvent[];
  /** The run's worktree — the cwd the SDK triage query runs in (per-run). */
  cwd: string;
}

/** The advisor's verdict: a triage decision + a one-line rationale (for the log). */
export interface SupervisorAdvice {
  decision: TriageDecision;
  rationale: string;
}

/** The triage surface the SDK session depends on (fakeable). */
export interface SupervisorAdvisor {
  advise(req: SupervisorAdviceRequest): Promise<SupervisorAdvice>;
}

/** JSON schema the SDK `outputFormat` enforces for a structured triage verdict. */
export const SUPERVISOR_TRIAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'rationale'],
  properties: {
    decision: { type: 'string', enum: ['retry', 'escalate', 'fail'] },
    rationale: { type: 'string', description: 'one sentence: why this decision' },
  },
};

/** A `TriageDecision` type guard (narrows the structured-output `decision`). */
function isTriageDecision(v: unknown): v is TriageDecision {
  return v === 'retry' || v === 'escalate' || v === 'fail';
}

/**
 * Parse the SDK's structured-output object into a `SupervisorAdvice`. Lenient and
 * never throws: an unrecognized / missing decision falls back to 'escalate' (route
 * to the human seam — the safe default when the agent's verdict is unusable).
 */
export function parseSupervisorAdvice(structured: unknown): SupervisorAdvice {
  if (typeof structured === 'object' && structured !== null) {
    const o = structured as Record<string, unknown>;
    if (isTriageDecision(o.decision)) {
      return {
        decision: o.decision,
        rationale: typeof o.rationale === 'string' ? o.rationale : '',
      };
    }
  }
  return { decision: 'escalate', rationale: 'unparseable triage verdict — escalating to human' };
}

/**
 * Compose the scoped triage prompt for one failed step. Pure (output depends only
 * on its args). Instructs the agent to weigh the failure + recent run context and
 * return exactly one of retry / escalate / fail via the structured output.
 */
export function buildSupervisorTriagePrompt(req: SupervisorAdviceRequest): string {
  const events =
    req.recentEvents.length > 0
      ? req.recentEvents
          .map((e) => `- ${e.kind}${e.stepId ? ` [${e.stepId}]` : ''}${e.error ? `: ${e.error}` : ''}`)
          .join('\n')
      : '- (no prior events)';

  return `You are the SUPERVISOR of a "${req.workflowName}" workflow run. You do NOT run the steps — host code does. Your job is to TRIAGE a step that has exhausted its automatic retries.

Failed step: **${req.failedStep.name}** (id: \`${req.failedStep.id}\`, agent: \`${req.failedStep.agent}\`)
Error: ${req.error ?? '(no error message captured)'}

Recent run events (most recent first):
${events}

Decide ONE triage action and return it as structured output:
- "retry"    — the failure looks transient/flaky and a fresh attempt is likely to succeed.
- "escalate" — a human should decide (ambiguous, risky, or needs a judgement call). Prefer this when unsure.
- "fail"     — the failure is definitive and retrying or human review won't help; end the run.

Return only the structured { decision, rationale } object.`;
}

/** Per-run options for an SdkSupervisorSession. */
export interface SdkSupervisorOptions {
  /** Max monitor events retained for context (most recent kept). Default 20. */
  maxEvents?: number;
}

/**
 * The SupervisorSession backed by an SDK triage advisor. Accumulates the monitor
 * feed in a bounded ring buffer and, on a required-step failure, asks the advisor
 * for a verdict. Fail-soft: an advisor error → 'escalate' (route to human), never
 * a hard fail of the run on a flaky supervisor.
 */
export class SdkSupervisorSession implements SupervisorSession {
  private readonly maxEvents: number;
  private events: SupervisorEvent[] = [];
  private ctx: SupervisorContext | null = null;

  constructor(
    private readonly advisor: SupervisorAdvisor,
    opts?: SdkSupervisorOptions,
    private readonly logger?: LoggerLike,
  ) {
    this.maxEvents = opts?.maxEvents ?? 20;
  }

  async start(ctx: SupervisorContext): Promise<void> {
    this.ctx = ctx;
    this.events = [];
    this.logger?.info('[SdkSupervisorSession] supervising programmatic run', {
      runId: ctx.runId,
      workflow: ctx.workflowName,
    });
  }

  notify(event: SupervisorEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  async triage(req: SupervisorTriageRequest): Promise<TriageDecision> {
    const step: WorkflowStep = req.step;
    try {
      const advice = await this.advisor.advise({
        workflowName: this.ctx?.workflowName ?? 'workflow',
        failedStep: { id: step.id, name: step.name, agent: step.agent },
        error: req.error,
        recentEvents: [...this.events].reverse(), // most recent first
        cwd: this.ctx?.worktreePath ?? process.cwd(),
      });
      this.logger?.info('[SdkSupervisorSession] triage verdict', {
        runId: this.ctx?.runId,
        stepId: step.id,
        decision: advice.decision,
        rationale: advice.rationale,
      });
      return advice.decision;
    } catch (err) {
      // A broken advisor must not hard-fail the run — escalate to the human seam.
      this.logger?.warn('[SdkSupervisorSession] advisor failed; escalating to human', {
        runId: this.ctx?.runId,
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'escalate';
    }
  }

  async stop(): Promise<void> {
    this.events = [];
    this.ctx = null;
  }
}

/**
 * A one-shot structured SDK query: send `prompt`, enforce `schema` via the SDK's
 * native `outputFormat`, return the parsed structured object. The single seam the
 * real SDK call sits behind; implemented in `sdkStructuredQuery.ts` and faked in
 * tests.
 */
export interface StructuredQueryFn {
  (args: { prompt: string; schema: Record<string, unknown>; cwd: string; model?: string }): Promise<unknown>;
}

/**
 * The production `SupervisorAdvisor`: builds the triage prompt, runs a one-shot
 * structured SDK query (via the injected `StructuredQueryFn`), and parses the
 * verdict. The unverifiable live SDK work is entirely inside the injected fn.
 */
export class SdkSupervisorAdvisor implements SupervisorAdvisor {
  constructor(
    private readonly queryFn: StructuredQueryFn,
    private readonly opts: { model?: string } = {},
  ) {}

  async advise(req: SupervisorAdviceRequest): Promise<SupervisorAdvice> {
    const prompt = buildSupervisorTriagePrompt(req);
    const structured = await this.queryFn({
      prompt,
      schema: SUPERVISOR_TRIAGE_SCHEMA,
      cwd: req.cwd,
      ...(this.opts.model ? { model: this.opts.model } : {}),
    });
    return parseSupervisorAdvice(structured);
  }
}
