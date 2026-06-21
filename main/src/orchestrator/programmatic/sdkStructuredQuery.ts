/**
 * The REAL one-shot structured SDK query behind `StructuredQueryFn` (Stage 3 SDK
 * supervisor). This is the SOLE importer of `@anthropic-ai/claude-agent-sdk` in
 * the programmatic/ tree — keeping the controller, supervisor brain, and host free
 * of the SDK so they stay standalone-typecheckable and exhaustively fakeable.
 *
 * It runs a single-turn `query()` with the SDK's native `outputFormat` (JSON
 * schema) and drains the iterator for the final result's `structured_output`.
 * Unlike the per-step `spawnCliProcess` path (stream-and-drain, no return value),
 * this is request/response — exactly what a triage verdict needs.
 *
 * ⚠️ NOT live-verifiable headlessly (it makes a real Claude call). It is reached
 * ONLY when the SDK supervisor is opted in (config `programmaticSupervisor: 'sdk'`),
 * so the risk is contained — the default `ReviewQueueSupervisor` never imports this.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { LoggerLike } from '../types';
import { resolveClaudeExecutablePath } from '../../services/panels/claude/claudeExecutablePath';
import type { StructuredQueryFn } from './sdkSupervisor';

/**
 * Build the production `StructuredQueryFn`. A single-turn, tool-less structured
 * query: the supervisor only needs a judgement, so `maxTurns: 1` keeps it cheap
 * and bounded. Returns the structured_output (or null on any non-success / drain
 * without a structured result — `parseSupervisorAdvice` then falls back to
 * 'escalate').
 */
export function makeSdkStructuredQuery(logger?: LoggerLike): StructuredQueryFn {
  return async ({ prompt, schema, cwd, model }) => {
    const abortController = new AbortController();
    try {
      const q = query({
        prompt,
        options: {
          cwd,
          ...(model ? { model } : {}),
          maxTurns: 1,
          // No tools — this is a pure judgement call, not an editing turn.
          allowedTools: [],
          pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
          outputFormat: { type: 'json_schema', schema },
          abortController,
        },
      });

      let structured: unknown = null;
      for await (const msg of q) {
        if (msg.type === 'result' && msg.subtype === 'success') {
          structured = msg.structured_output ?? null;
        }
      }
      return structured;
    } catch (err) {
      logger?.warn('[sdkStructuredQuery] structured supervisor query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Surfacing as a throw lets SdkSupervisorSession.triage escalate to human.
      throw err instanceof Error ? err : new Error(String(err));
    }
  };
}
