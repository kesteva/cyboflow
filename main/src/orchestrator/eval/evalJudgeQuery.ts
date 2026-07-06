/**
 * evalJudgeQuery — the SDK boundary for the code-review eval jury. This is the
 * ONLY `@anthropic-ai/claude-agent-sdk` importer in the eval/ tree, exactly
 * mirroring monitorQuery.ts in the programmatic/ tree: keeping the jury, worker,
 * scoring, and snapshot SDK-free means they stay standalone-typecheckable and the
 * jury is fully fakeable in tests (inject a `EvalStructuredQueryFn` that returns a
 * canned object — no claude subprocess).
 *
 * A single call is a one-shot STRUCTURED query: send the judge prompt, enforce the
 * per-sub-check verdict schema via the SDK's native `outputFormat: json_schema`,
 * drain the stream, and return the `structured_output` from the success result.
 * Read-only tools (Read/Grep/Glob) + the frozen worktree as cwd let the judge grep
 * the snapshot before marking UNKNOWN (the rubric's evidence rule) — but the
 * worktree may be torn down mid-eval by a fast human merge, so the worker passes
 * cwd only when it still exists and the prompt is diff-self-contained regardless.
 *
 * v1 limitation (documented): the Agent SDK query() options expose NO temperature,
 * so the design's "temp 0" is unsettable; K-sample variance is whatever the model
 * produces. packaged builds MUST pass pathToClaudeCodeExecutable (asar ENOTDIR
 * spawn class) — resolveClaudeExecutablePath() handles it.
 *
 * ⚠️ NOT live-verifiable headlessly (it makes a real Claude call).
 *
 * Standalone-typecheck note: nothing here imports electron / better-sqlite3 / a
 * concrete service beyond the claude-exe resolver and the pure model-alias helper.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LoggerLike } from '../types';
import { resolveClaudeExecutablePath } from '../../services/panels/claude/claudeExecutablePath';

/** Default per-sample deadline. A hung claude binary must not stall the worker. */
export const EVAL_JUDGE_TIMEOUT_MS = 180_000;

/** Read-only tools the judge may use to grep/open the frozen snapshot. */
const JUDGE_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/**
 * Turn budget: enough to inspect the worktree (read-only) AND emit the final
 * structured verdict. Diff-only evals (worktree gone) need far fewer, but the
 * hard deadline is the real bound.
 */
const JUDGE_MAX_TURNS = 32;

/**
 * A one-shot STRUCTURED SDK query: send `prompt`, enforce `schema` via the SDK's
 * native `outputFormat`, return the parsed structured object (or null on
 * drain-without-result). Fakeable in tests (no SDK).
 */
export interface EvalStructuredQueryFn {
  (args: {
    prompt: string;
    schema: Record<string, unknown>;
    cwd?: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

/**
 * Bridge a caller's optional AbortSignal onto a fresh AbortController + a deadline
 * timer (mirrors monitorQuery.makeDeadline). Aborting on the caller's signal or the
 * deadline ends the SDK `for await` loop.
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
 * Build the production `EvalStructuredQueryFn`. Bounded structured query: the judge
 * may inspect the worktree (read-only, up to JUDGE_MAX_TURNS) before emitting the
 * structured verdict enforced by `schema`. On timeout/error: aborts and THROWS (the
 * jury treats a throw as a malformed sample → retry once, then drop).
 */
export function makeEvalJudgeQuery(
  logger?: LoggerLike,
  timeoutMs: number = EVAL_JUDGE_TIMEOUT_MS,
): EvalStructuredQueryFn {
  return async ({ prompt, schema, cwd, model, signal }) => {
    const { controller, didTimeOut, cleanup } = makeDeadline(timeoutMs, signal);
    try {
      // Single-shot STRING prompt (not streaming-input): this is a bounded,
      // read-only Q&A with JUDGE_ALLOWED_TOOLS only — no AskUserQuestion or any
      // interactive canUseTool "ask" — so it never needs stdin held open for
      // control roundtrips, and closing stdin after the message lets the CLI exit
      // cleanly on its own. (Contrast claudeCodeManager's flow turns, which MUST
      // stream input to keep the AskUserQuestion gate alive; see
      // services/panels/claude/streamingPromptInput.ts.)
      const q = query({
        prompt,
        options: {
          ...(cwd ? { cwd } : {}),
          ...(model ? { model } : {}),
          maxTurns: JUDGE_MAX_TURNS,
          allowedTools: [...JUDGE_ALLOWED_TOOLS],
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
      if (didTimeOut()) throw new Error(`eval judge query timed out after ${timeoutMs}ms`);
      return structured;
    } catch (err) {
      const message = didTimeOut()
        ? `eval judge query timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger?.warn('[evalJudgeQuery] structured query failed', { error: message });
      throw new Error(message);
    } finally {
      cleanup();
    }
  };
}
