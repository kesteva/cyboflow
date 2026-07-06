/**
 * monitorQuery — the SDK boundary for the on-demand monitor (the unify-monitor
 * refactor; supersedes the Stage 3 one-shot supervisor query). This is the ONLY
 * `@anthropic-ai/claude-agent-sdk` importer in the programmatic/ tree after the
 * refactor, keeping the monitor brain (`monitor.ts`), the controller, and the host
 * SDK-free so they stay standalone-typecheckable and exhaustively fakeable.
 *
 * It exposes TWO fakeable function shapes the monitor brain depends on:
 *   - `StructuredQueryFn` — a one-shot structured query (request/response via the
 *     SDK's native `outputFormat: json_schema`), used for TRIAGE verdicts.
 *   - `TextQueryFn`       — a one-shot text query (no outputFormat), used to ANSWER
 *     a human's chat question with a grounded natural-language reply.
 *
 * Both real impls allow READ-ONLY inspection tools (`Read`/`Grep`/`Glob`) and a
 * small `maxTurns` so the monitor can inspect the worktree before answering, then
 * are bounded by a hard timeout: a hung claude binary must not stall the run — on
 * timeout we abort the in-flight query and throw (the monitor brain then fails-soft:
 * triage → 'escalate', answer → an apologetic string).
 *
 * ⚠️ NOT live-verifiable headlessly (it makes a real Claude call). Since the
 * supervisor-role redesign (2026-07-05) the monitor is ALWAYS built for
 * programmatic runs, but this boundary is still only reached on demand — a triage
 * of an exhausted required failure or a human chat turn; routine progress never
 * calls it.
 *
 * Standalone-typecheck note: this is the SDK-importing leaf; nothing here imports
 * electron / better-sqlite3 / a concrete service beyond the claude-exe resolver.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LoggerLike } from '../types';
import { resolveClaudeExecutablePath } from '../../services/panels/claude/claudeExecutablePath';

/**
 * Default deadline for a single monitor query (triage OR answer). A hung claude
 * binary must not stall the whole programmatic run — on timeout we abort + throw,
 * and the monitor brain (`DefaultMonitorSession`) fails-soft (triage escalates,
 * answer returns an apology).
 */
export const SUPERVISOR_QUERY_TIMEOUT_MS = 120_000;

/** Read-only inspection tools the monitor may use to ground a triage / answer. */
const MONITOR_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/**
 * Turn budget: enough turns to inspect the worktree (read-only Read/Grep/Glob) AND
 * emit the final verdict / answer. The monitor is on-demand — it acts rarely, so a
 * generous budget is cheap. 6 was too tight: a single "what's the current state?"
 * answer reads several files and blew past it, so the SDK threw `error_max_turns`
 * and the user saw a fail-soft apology on the first ask (smoke 2026-06-22). The hard
 * `SUPERVISOR_QUERY_TIMEOUT_MS` deadline is the real safety bound, not this count.
 */
const MONITOR_MAX_TURNS = 24;

/**
 * A one-shot STRUCTURED SDK query: send `prompt`, enforce `schema` via the SDK's
 * native `outputFormat`, return the parsed structured object (or null). The monitor
 * brain parses it leniently. Fakeable in tests (no SDK).
 */
export interface StructuredQueryFn {
  (args: {
    prompt: string;
    schema: Record<string, unknown>;
    cwd: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

/**
 * A one-shot TEXT SDK query: send `prompt`, return the final assistant message's
 * concatenated text ('' if none). Fakeable in tests (no SDK).
 */
export interface TextQueryFn {
  (args: { prompt: string; cwd: string; model?: string; signal?: AbortSignal }): Promise<string>;
}

/** Concatenate the text blocks of an SDK assistant message (string or block[]). */
function assistantText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

/**
 * Bridge a caller's optional AbortSignal onto a fresh AbortController + a deadline
 * timer. Returns the controller, a `timedOut` flag reader, and a cleanup fn.
 * Aborting on the caller's signal or the deadline ends the SDK `for await` loop.
 */
function makeDeadline(timeoutMs: number, signal?: AbortSignal): {
  controller: AbortController;
  didTimeOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Bridge the caller's cancel signal: if it fires, abort the in-flight query too.
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
 * Build the production `StructuredQueryFn`. A bounded structured query: the monitor
 * may inspect the worktree (read-only tools, up to `MONITOR_MAX_TURNS`) before
 * emitting the structured verdict enforced by `schema`. Returns the structured
 * output (or null on drain-without-result; the brain falls back to 'escalate').
 * On timeout/error: aborts and THROWS (the brain escalates).
 */
export function makeSdkStructuredQuery(
  logger?: LoggerLike,
  timeoutMs: number = SUPERVISOR_QUERY_TIMEOUT_MS,
): StructuredQueryFn {
  return async ({ prompt, schema, cwd, model, signal }) => {
    const { controller, didTimeOut, cleanup } = makeDeadline(timeoutMs, signal);
    try {
      // Single-shot STRING prompt (not streaming-input): a bounded, read-only
      // triage query with MONITOR_ALLOWED_TOOLS only — no AskUserQuestion or any
      // interactive canUseTool "ask" — so it needs no stdin held open for control
      // roundtrips and terminates cleanly after the result. (Flow turns in
      // claudeCodeManager MUST stream input; see streamingPromptInput.ts.)
      const q = query({
        prompt,
        options: {
          cwd,
          ...(model ? { model } : {}),
          maxTurns: MONITOR_MAX_TURNS,
          allowedTools: [...MONITOR_ALLOWED_TOOLS],
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
      if (didTimeOut()) throw new Error(`monitor triage query timed out after ${timeoutMs}ms`);
      return structured;
    } catch (err) {
      const message = didTimeOut()
        ? `monitor triage query timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger?.warn('[monitorQuery] structured query failed', { error: message });
      throw new Error(message);
    } finally {
      cleanup();
    }
  };
}

/**
 * Build the production `TextQueryFn`. A bounded text query with NO outputFormat: the
 * monitor may inspect the worktree (read-only tools, up to `MONITOR_MAX_TURNS`) and
 * returns the concatenated text of the LAST assistant message ('' if none). On
 * timeout/error: aborts and THROWS (the brain returns an apologetic answer).
 */
export function makeSdkTextQuery(
  logger?: LoggerLike,
  timeoutMs: number = SUPERVISOR_QUERY_TIMEOUT_MS,
): TextQueryFn {
  return async ({ prompt, cwd, model, signal }) => {
    const { controller, didTimeOut, cleanup } = makeDeadline(timeoutMs, signal);
    // Keep the LAST assistant message's text — later turns supersede earlier ones
    // (the monitor may speak mid-inspection, but its final turn is the answer).
    // Hoisted out of the try so a mid-stream error (e.g. the SDK throwing
    // `error_max_turns`) can still return whatever the monitor had already said.
    let answer = '';
    try {
      // Single-shot STRING prompt (not streaming-input): same rationale as the
      // structured query above — read-only, no interactive tools, terminates on
      // its own. See streamingPromptInput.ts for the flow-turn streaming case.
      const q = query({
        prompt,
        options: {
          cwd,
          ...(model ? { model } : {}),
          maxTurns: MONITOR_MAX_TURNS,
          allowedTools: [...MONITOR_ALLOWED_TOOLS],
          pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
          abortController: controller,
        },
      });

      for await (const msg of q) {
        if (msg.type === 'assistant') {
          const text = assistantText(msg.message);
          if (text.length > 0) answer = text;
        }
      }
      if (didTimeOut()) throw new Error(`monitor answer query timed out after ${timeoutMs}ms`);
      return answer;
    } catch (err) {
      const message = didTimeOut()
        ? `monitor answer query timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger?.warn('[monitorQuery] text query failed', { error: message });
      // Graceful degradation: if the monitor produced a partial answer before the
      // error (a turn-cap hit mid-investigation, a timeout after it spoke), surface
      // THAT rather than throwing → the user sees a useful (if incomplete) reply
      // instead of a bare apology. Only rethrow when there is nothing to show.
      if (answer.trim().length > 0) return answer;
      throw new Error(message);
    } finally {
      cleanup();
    }
  };
}
