/**
 * revisionQuery — the SDK boundary for the in-artifact feedback REVISION agent
 * (IDEA-033). This is the ONLY `@anthropic-ai/claude-agent-sdk` importer in the
 * feedback/ tree, exactly mirroring evalJudgeQuery.ts in the eval/ tree: keeping
 * the worker, prompt-builder, and splice logic SDK-free means they stay
 * standalone-typecheckable and the whole revision path is fully fakeable in tests
 * (inject a `RevisionQueryFn` that returns a canned object — no claude subprocess).
 *
 * A single call is a one-shot STRUCTURED query: send the revision prompt, enforce
 * the `{ revisedDocument, notes? }` schema via the SDK's native
 * `outputFormat: json_schema`, drain the stream, and return the `structured_output`
 * from the success result. Read-only tools (Read/Grep/Glob) + the run's frozen
 * worktree as cwd let the agent ground its revision in the codebase before it
 * emits the rewritten document — but the worktree may be torn down mid-revision,
 * so the worker passes cwd only when it still exists (mirroring evalWorker).
 *
 * packaged builds MUST pass pathToClaudeCodeExecutable (asar ENOTDIR spawn class) —
 * resolveClaudeExecutablePath() handles it.
 *
 * ⚠️ NOT live-verifiable headlessly (it makes a real Claude call).
 *
 * Standalone-typecheck note: nothing here imports electron / better-sqlite3 / a
 * concrete service beyond the claude-exe resolver.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LoggerLike } from '../types';
import { resolveClaudeExecutablePath } from '../../services/panels/claude/claudeExecutablePath';

/** Default per-revision deadline. A hung claude binary must not stall the worker. */
export const REVISION_QUERY_TIMEOUT_MS = 300_000;

/** Read-only tools the revision agent may use to ground its rewrite. */
const REVISION_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/**
 * Turn budget: enough to inspect the worktree (read-only) AND emit the final
 * structured document. The hard deadline is the real bound.
 */
const REVISION_MAX_TURNS = 32;

/**
 * A one-shot STRUCTURED SDK query: send `prompt`, enforce `schema` via the SDK's
 * native `outputFormat`, return the parsed structured object (or null on
 * drain-without-result). Fakeable in tests (no SDK).
 */
export interface RevisionQueryFn {
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
 * Build the production `RevisionQueryFn`. Bounded structured query: the agent may
 * inspect the worktree (read-only, up to REVISION_MAX_TURNS) before emitting the
 * structured `{ revisedDocument }` enforced by `schema`. On timeout/error: aborts
 * and THROWS (the worker treats a throw as a failed revision → batch-failed).
 *
 * The judge MODEL is caller-supplied (mirroring evalWorker, where each jury slot
 * carries its own model and the eval query just threads it through); undefined
 * falls through to the SDK default, which is acceptable for the revision agent.
 */
export function makeRevisionQuery(
  logger?: LoggerLike,
  timeoutMs: number = REVISION_QUERY_TIMEOUT_MS,
): RevisionQueryFn {
  return async ({ prompt, schema, cwd, model, signal }) => {
    const { controller, didTimeOut, cleanup } = makeDeadline(timeoutMs, signal);
    try {
      // Single-shot STRING prompt (not streaming-input): a bounded, read-only
      // rewrite with REVISION_ALLOWED_TOOLS only — no AskUserQuestion or any
      // interactive canUseTool "ask" — so it never needs stdin held open for
      // control roundtrips, and closing stdin after the message lets the CLI exit
      // cleanly on its own. (Mirrors evalJudgeQuery.)
      const q = query({
        prompt,
        options: {
          ...(cwd ? { cwd } : {}),
          ...(model ? { model } : {}),
          maxTurns: REVISION_MAX_TURNS,
          allowedTools: [...REVISION_ALLOWED_TOOLS],
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
      if (didTimeOut()) throw new Error(`revision query timed out after ${timeoutMs}ms`);
      return structured;
    } catch (err) {
      const message = didTimeOut()
        ? `revision query timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger?.warn('[revisionQuery] structured query failed', { error: message });
      throw new Error(message);
    } finally {
      cleanup();
    }
  };
}
