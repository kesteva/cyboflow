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
import { isAgentProviderDisabled } from '../../../../shared/agents/agentProviderGuard';
import { hasResolvedModel } from './judgeSlots';

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
      if (isAgentProviderDisabled(err, 'codex')) {
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
