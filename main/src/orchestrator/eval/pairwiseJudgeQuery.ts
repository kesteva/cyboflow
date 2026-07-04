/**
 * pairwiseJudgeQuery — the SDK boundary for the A/B pairwise judge (slice C). A
 * sibling of evalJudgeQuery.ts: the ONLY `@anthropic-ai/claude-agent-sdk`
 * importer in the pairwise tree, so the worker, scoring, and prompt-build modules
 * stay standalone-typecheckable and fully fakeable (inject a
 * `PairwiseStructuredQueryFn` that returns a canned object — no claude
 * subprocess).
 *
 * A single call is a one-shot STRUCTURED query: send the pairwise prompt, enforce
 * the {preference, confidence, rationale} schema via the SDK's native
 * `outputFormat: json_schema`, drain the stream, and return the
 * `structured_output`.
 *
 * Differences from evalJudgeQuery (deliberate):
 *  - NO cwd. The judge compares two FROZEN diffs from two DIFFERENT arm worktrees;
 *    it cannot cwd into both, and the diffs are self-contained on the comparison
 *    row (worktree teardown happens at experiments.decide). Diff-only grading.
 *  - maxTurns: 8 (no worktree grep loop to budget for).
 *
 * v1 limitation (documented, shared with evalJudgeQuery): the Agent SDK query()
 * options expose NO temperature, so K-sample variance is whatever the model
 * produces; position-bias is cancelled by randomizing which arm is "Solution 1"
 * per sample. Packaged builds MUST pass pathToClaudeCodeExecutable (asar ENOTDIR
 * spawn class) — resolveClaudeExecutablePath() handles it.
 *
 * ⚠️ NOT live-verifiable headlessly (it makes a real Claude call).
 *
 * Standalone-typecheck note: nothing here imports electron / better-sqlite3 / a
 * concrete service beyond the claude-exe resolver.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LoggerLike } from '../types';
import { resolveClaudeExecutablePath } from '../../services/panels/claude/claudeExecutablePath';

/** Default per-sample deadline. A hung claude binary must not stall the worker. */
export const PAIRWISE_JUDGE_TIMEOUT_MS = 180_000;

/** Read-only tools the judge may use (diff-only grading needs none, kept for parity). */
const PAIRWISE_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** Turn budget: emit the final structured verdict. No worktree loop (diff-only). */
const PAIRWISE_MAX_TURNS = 8;

/**
 * A one-shot STRUCTURED SDK query: send `prompt`, enforce `schema` via the SDK's
 * native `outputFormat`, return the parsed structured object (or null on
 * drain-without-result). Fakeable in tests (no SDK).
 */
export interface PairwiseStructuredQueryFn {
  (args: {
    prompt: string;
    schema: Record<string, unknown>;
    model?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

/**
 * Bridge a caller's optional AbortSignal onto a fresh AbortController + a deadline
 * timer (mirrors evalJudgeQuery.makeDeadline). Aborting on the caller's signal or
 * the deadline ends the SDK `for await` loop.
 */
function makeDeadline(
  timeoutMs: number,
  signal?: AbortSignal,
): { controller: AbortController; didTimeOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = (): void => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    controller,
    didTimeOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Build the production `PairwiseStructuredQueryFn`. Bounded structured query: the
 * judge emits the structured verdict enforced by `schema`. On timeout/error:
 * aborts and THROWS (the worker treats a throw as a malformed sample → retry once,
 * then drop).
 */
export function makePairwiseJudgeQuery(
  logger?: LoggerLike,
  timeoutMs: number = PAIRWISE_JUDGE_TIMEOUT_MS,
): PairwiseStructuredQueryFn {
  return async ({ prompt, schema, model, signal }) => {
    const { controller, didTimeOut, cleanup } = makeDeadline(timeoutMs, signal);
    try {
      const q = query({
        prompt,
        options: {
          ...(model ? { model } : {}),
          maxTurns: PAIRWISE_MAX_TURNS,
          allowedTools: [...PAIRWISE_ALLOWED_TOOLS],
          pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
          outputFormat: { type: 'json_schema', schema },
          abortController: controller,
        },
      });

      let structured: unknown = null;
      for await (const msg of q) {
        if (msg.type === 'result' && msg.subtype === 'success') {
          structured = msg.structured_output ?? null;
        }
      }
      if (didTimeOut()) throw new Error(`pairwise judge query timed out after ${timeoutMs}ms`);
      return structured;
    } catch (err) {
      const message = didTimeOut()
        ? `pairwise judge query timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger?.warn('[pairwiseJudgeQuery] structured query failed', { error: message });
      throw new Error(message);
    } finally {
      cleanup();
    }
  };
}
