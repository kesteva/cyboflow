import type { LoggerLike } from '../types';
import type { EvalStructuredQueryFn } from './evalJudgeQuery';
import {
  JUDGE_OUTPUT_SCHEMA,
  buildJudgePrompt,
  parseJudgeSample,
  type JudgeClient,
  type JudgeGradeInput,
} from './evalJury';
import type { JudgeSample } from './scoring';
import { AgentProviderDisabledError } from '../../../../shared/agents/agentProviderGuard';

export type CodexJurorUnavailableCode = 'runtime-missing' | 'logged-out' | 'provider-disabled';

export class CodexJurorUnavailableError extends Error {
  override readonly name = 'CodexJurorUnavailableError';

  constructor(
    message: string,
    readonly code: CodexJurorUnavailableCode,
  ) {
    super(message);
  }
}

/**
 * True when `err` is a CODEX provider-disabled refusal. Scoped to `codex` on the
 * typed branch so a refusal for a DIFFERENT provider is never rewrapped as a
 * Codex-juror outage. Mirrors codexPairwiseJudge.ts's predicate of the same name
 * — the two adapters map this refusal identically, see codexPairwiseJudge.ts's
 * header comment for why the mapping belongs to the adapter, not the app-server
 * client.
 */
function isAgentProviderDisabledError(err: unknown): boolean {
  if (err instanceof AgentProviderDisabledError) return err.provider === 'codex';
  return err instanceof Error && err.name === 'AgentProviderDisabledError';
}

interface QueryWithResolvedModel {
  getResolvedModel(): string | null;
}

function hasResolvedModel(query: EvalStructuredQueryFn): query is EvalStructuredQueryFn & QueryWithResolvedModel {
  return 'getResolvedModel' in query
    && typeof (query as { getResolvedModel?: unknown }).getResolvedModel === 'function';
}

export interface CodexJudgeDeps {
  structuredQuery: EvalStructuredQueryFn;
  model?: string;
  logger?: LoggerLike;
  resolvedModel?: string;
}

/** Pure jury adapter; the impure app-server lifecycle is injected by index.ts. */
export class CodexJudge implements JudgeClient {
  readonly name = 'codex';
  resolvedModel: string | undefined;
  private readonly deps: CodexJudgeDeps;

  constructor(deps: CodexJudgeDeps) {
    this.deps = deps;
    this.resolvedModel = deps.resolvedModel ?? deps.model;
  }

  async grade(input: JudgeGradeInput): Promise<JudgeSample> {
    const prompt = buildJudgePrompt(input);
    try {
      const raw = await this.deps.structuredQuery({
        prompt,
        schema: JUDGE_OUTPUT_SCHEMA,
        // Same deadline-stretch signal the Claude slots send (judgeDeadline).
        diffChars: input.diff.length,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(this.deps.model ? { model: this.deps.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return parseJudgeSample(raw);
    } catch (err) {
      if (err instanceof CodexJurorUnavailableError) {
        throw err; // pass through by identity — do not rewrap an already-typed refusal
      }
      if (isAgentProviderDisabledError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger?.warn('[codexJudge] Codex provider disabled', { error: message });
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
