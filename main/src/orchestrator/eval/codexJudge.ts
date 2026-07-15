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

export type CodexJurorUnavailableCode = 'runtime-missing' | 'logged-out';

export class CodexJurorUnavailableError extends Error {
  override readonly name = 'CodexJurorUnavailableError';

  constructor(
    message: string,
    readonly code: CodexJurorUnavailableCode,
  ) {
    super(message);
  }
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
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(this.deps.model ? { model: this.deps.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return parseJudgeSample(raw);
    } finally {
      if (hasResolvedModel(this.deps.structuredQuery)) {
        this.resolvedModel = this.deps.structuredQuery.getResolvedModel() ?? this.resolvedModel;
      }
    }
  }
}
