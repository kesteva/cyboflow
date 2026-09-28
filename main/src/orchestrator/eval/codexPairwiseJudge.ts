/**
 * codexPairwiseJudge — the Codex implementation of `PairwiseJudgeClient`
 * (pairwiseJudge.ts), sibling of codexJudge.ts (the rubric-jury Codex adapter).
 * Reuses the shared pairwise pieces VERBATIM — `buildPairwisePrompt`,
 * `PAIRWISE_OUTPUT_SCHEMA`, `parsePairwiseSample` — so the prompt/schema/parser
 * are identical across the Claude and Codex pairwise jurors; only the transport
 * (which structured-query fn is injected) differs.
 *
 * Deps are typed as `PairwiseStructuredQueryFn` (the Claude-tree query-fn shape),
 * NOT the Codex-specific `CodexEvalStructuredQueryFn`, so tests can inject a
 * plain fake with no Codex app-server machinery in scope. The real Codex query
 * fn (codexEvalJudgeQuery.ts) remains assignable here because `cwd` is OPTIONAL
 * on the Eval arg shape (evalJudgeQuery.ts) and simply ABSENT from the Pairwise
 * one (pairwiseJudgeQuery.ts) — the narrower Pairwise arg is still assignable to
 * the wider Eval param, by parameter contravariance. Making `cwd` required on the
 * Eval shape would break that assignment.
 *
 * Invariants (deliberate, mirrored from pairwiseJudgeQuery.ts's header comment):
 *  - NO `cwd` is ever passed. `PairwiseGradeInput` carries none by design — the
 *    judge compares two FROZEN diffs pulled from two DIFFERENT arm worktrees, so
 *    there is no single directory to cwd into (see pairwiseJudgeQuery.ts:15-19).
 *  - NO timeout/deadline is set here. This class has no timeout parameter at
 *    all; the injected Codex query factory already defaults to
 *    CODEX_EVAL_JUDGE_TIMEOUT_MS (600_000ms, codexEvalJudgeQuery.ts:35) — the
 *    shorter 180s wall belongs only to the Claude pairwise judge
 *    (makePairwiseJudgeQuery), not this one.
 *  - The output schema is passed by IDENTITY, unmodified. It must not be cloned,
 *    spread, or loosened — the SDK's Codex → OpenAI strict-structured-output path
 *    rejects any schema whose `required` list omits a property, so relaxing a
 *    field here would reproduce the exact 400 class documented at
 *    codexEvalJudgeQuery.ts:324-329 ("Missing '<field>'"). PAIRWISE_OUTPUT_SCHEMA
 *    already lists all three properties as required with
 *    additionalProperties:false, so it needs no strict-ification at this layer.
 *
 * Provider-disabled mapping: `CodexAppServerClient.start()` asserts the Codex
 * provider toggle via `assertAgentProviderAllowed('codex', …)` and throws a raw
 * `AgentProviderDisabledError` (agentProviderGuard.ts), not a
 * `CodexJurorUnavailableError` — that mapping is this adapter's job, exactly as
 * codexJudge.ts does for the rubric jury. A `CodexJurorUnavailableError` that
 * already escaped the query fn (e.g. logged-out / runtime-missing) passes
 * through untouched, by identity.
 *
 * Standalone-typecheck note: `agentProviderGuard.ts` imports only shared types
 * (no electron / better-sqlite3 / SDK), so importing it here does not pull any
 * concrete service into the eval tree.
 */
import type { LoggerLike } from '../types';
import type { PairwiseStructuredQueryFn } from './pairwiseJudgeQuery';
import {
  PAIRWISE_OUTPUT_SCHEMA,
  buildPairwisePrompt,
  parsePairwiseSample,
  type PairwiseGradeInput,
  type PairwiseJudgeClient,
  type PairwiseRawResult,
} from './pairwiseJudge';
import { CodexJurorUnavailableError } from './codexJudge';
import { isAgentProviderDisabled } from '../../../../shared/agents/agentProviderGuard';
import { hasResolvedModel } from './judgeSlots';

export interface CodexPairwiseJudgeDeps {
  /** The Codex structured-query fn (real impl in codexEvalJudgeQuery.ts; a fake in tests). */
  structuredQuery: PairwiseStructuredQueryFn;
  model?: string;
  logger?: LoggerLike;
}

/** Pure jury adapter; the impure app-server lifecycle is injected by index.ts. */
export class CodexPairwiseJudge implements PairwiseJudgeClient {
  readonly name = 'codex-pairwise';
  resolvedModel: string | undefined;
  private readonly deps: CodexPairwiseJudgeDeps;

  constructor(deps: CodexPairwiseJudgeDeps) {
    this.deps = deps;
    this.resolvedModel = deps.model;
  }

  async grade(input: PairwiseGradeInput): Promise<PairwiseRawResult> {
    const prompt = buildPairwisePrompt(input);
    try {
      const raw = await this.deps.structuredQuery({
        prompt,
        schema: PAIRWISE_OUTPUT_SCHEMA,
        ...(this.deps.model ? { model: this.deps.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return parsePairwiseSample(raw);
    } catch (err) {
      if (err instanceof CodexJurorUnavailableError) {
        throw err; // pass through by identity — do not rewrap an already-typed refusal
      }
      if (isAgentProviderDisabled(err, 'codex')) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger?.warn('[codexPairwiseJudge] Codex provider disabled', { error: message });
        throw new CodexJurorUnavailableError(message, 'provider-disabled');
      }
      throw err;
    } finally {
      if (hasResolvedModel(this.deps.structuredQuery)) {
        this.resolvedModel = this.deps.structuredQuery.getResolvedModel() ?? this.resolvedModel;
      }
    }
  }
}
