/**
 * sessionTokenUsage — pure aggregation of a quick session's chat-turn token
 * usage from its stored SDK `session_outputs` json rows.
 *
 * Why this is not a one-liner: SDK token usage is **nested**, never flat at the
 * top level of a stored output. A single chat turn emits several json rows, and
 * only some of them carry usage — at different paths:
 *
 *   - `result`  → the TURN total under `data.usage`, emitted exactly ONCE per
 *                 turn. This is the authoritative per-turn record, so it is what
 *                 we sum.
 *   - `assistant` → also carries `data.message.usage`, but SEVERAL fire per turn
 *                 (thinking + text + tool loops), so summing them double-counts
 *                 the turn. Skipped.
 *   - everything else (`stream_event` deltas, `system`/hook, `rate_limit_event`,
 *                 `session_info`) carries no turn usage. Ignored.
 *   - legacy rows that stored usage flat at the top level (no envelope `type`)
 *                 are still honoured for back-compat.
 *
 * The previous implementation read only the flat top-level `data.input_tokens`,
 * which NO SDK turn ever writes — so every quick-chat turn's tokens were dropped
 * and the session token meter only ever reflected hosted workflow-run usage.
 */

export interface SessionTokenTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  /** Turns that carried usage (one per SDK `result` message / legacy flat row). */
  messageCount: number;
}

/** The four usage fields the SDK reports per turn (all optional / may be 0). */
interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** A stored session_output envelope: either typed (with nested usage) or legacy-flat. */
interface SdkOutputEnvelope extends SdkUsage {
  type?: string;
  usage?: SdkUsage;
}

const toNumber = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/**
 * Pick the single authoritative usage record for one stored json output, or null
 * when the row carries no turn usage (see module doc for the precedence rules).
 */
function usageOf(data: SdkOutputEnvelope): SdkUsage | null {
  if (data.type === 'result' && data.usage && typeof data.usage === 'object') {
    return data.usage;
  }
  // Legacy: usage stored flat at the top level (no SDK envelope `type`).
  if (data.type === undefined && typeof data.input_tokens === 'number') {
    return data;
  }
  return null;
}

/**
 * Sum per-turn token usage across a session's `type='json'` session_outputs.
 * Pure — the caller supplies the already-queried `data` strings.
 */
export function sumSessionOutputTokenUsage(
  rows: ReadonlyArray<{ data: string }>,
): SessionTokenTotals {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let messageCount = 0;

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue; // Unparseable — skip.
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    const usage = usageOf(parsed as SdkOutputEnvelope);
    if (!usage) continue;

    totalInputTokens += toNumber(usage.input_tokens);
    totalOutputTokens += toNumber(usage.output_tokens);
    totalCacheReadTokens += toNumber(usage.cache_read_input_tokens);
    totalCacheCreationTokens += toNumber(usage.cache_creation_input_tokens);
    messageCount++;
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    messageCount,
  };
}
