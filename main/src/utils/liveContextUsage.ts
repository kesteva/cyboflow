/**
 * Live single-turn context derivation for the per-turn context meter (the
 * "Nk/1000k tokens (P%)" readout in ChatMetaStrip).
 *
 * Extracted from events.ts so it can be unit-tested in isolation — the flow-run
 * sibling, frontend/src/components/cyboflow/unified/runContextUsage.ts, is
 * likewise a standalone tested module guarding the SAME bug.
 *
 * THE BUG THIS GUARDS (quick-SDK path of f236fc63's flow-run fix)
 * --------------------------------------------------------------
 * A `result` event's `modelUsage` token counts are CUMULATIVE across every
 * internal tool-turn of the query. On a long, tool-heavy turn the cumulative
 * `inputTokens + cacheReadInputTokens` blows past the context window, and
 * clamping it with `Math.min(..., contextWindow)` silently floors it to the
 * window — so the meter pegged at "1000k/1000k tokens (100%)" before the next
 * turn snapped it back. Sourcing the numerator from a SINGLE assistant message's
 * usage (its live prompt for that one turn) never over-counts, so the clamp
 * becomes a genuine guard (a single turn CAN legitimately fill the window)
 * rather than a mask over a cumulative sum.
 */

/** Minimal shape of a buffered session output — `data` is the parsed JSON for
 *  `type === 'json'` outputs (the SDK message envelope). */
export interface ContextOutput {
  type: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** e.g. 76000 -> "76k", 200000 -> "200k"; sub-1k stays exact. */
export function formatContextTokens(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

/**
 * The live prompt size of a single assistant message: input + cache_read +
 * cache_creation (snake_case Anthropic usage shape on `message.usage`). Returns
 * null when the output is not an assistant message carrying a positive usage.
 */
function assistantLivePrompt(data: Record<string, unknown>): number | null {
  if (data.type !== 'assistant' || !isRecord(data.message)) return null;
  const usage = data.message.usage;
  if (!isRecord(usage)) return null;
  const live =
    numField(usage.input_tokens) +
    numField(usage.cache_read_input_tokens) +
    numField(usage.cache_creation_input_tokens);
  return live > 0 ? live : null;
}

/**
 * The context window from a result (`modelUsage[*].contextWindow`, camelCase) or
 * an init message (`context_window`, snake_case). Returns null when absent.
 */
function contextWindowOf(data: Record<string, unknown>): number | null {
  if (data.type === 'result' && isRecord(data.modelUsage)) {
    for (const modelData of Object.values(data.modelUsage)) {
      if (!isRecord(modelData)) continue;
      const cw = modelData.contextWindow;
      if (typeof cw === 'number' && cw > 0) return cw;
    }
    return null;
  }
  if (data.type === 'system' && data.subtype === 'init') {
    const cw = data.context_window;
    if (typeof cw === 'number' && cw > 0) return cw;
  }
  return null;
}

/**
 * Derive the live context-usage string from a list of session outputs.
 *
 * Pairs the most recent assistant message's live prompt size (numerator) with
 * the most recent result/init context window (denominator). Outputs are scanned
 * in iteration order, first match wins — callers pass newest-first when they
 * want the newest turn. Returns null when there is no assistant usage OR no
 * context window to pair it with (the caller then falls back to legacy
 * result/init/regex extraction).
 */
export function deriveLiveContextUsage(outputs: ReadonlyArray<ContextOutput>): string | null {
  let liveContext: number | null = null;
  let contextWindow: number | null = null;

  for (const output of outputs) {
    if (output.type !== 'json' || !isRecord(output.data)) continue;
    const data = output.data;

    if (liveContext === null) {
      const live = assistantLivePrompt(data);
      if (live !== null) liveContext = live;
    }
    if (contextWindow === null) {
      const cw = contextWindowOf(data);
      if (cw !== null) contextWindow = cw;
    }
    if (liveContext !== null && contextWindow !== null) break;
  }

  if (liveContext === null || contextWindow === null || contextWindow <= 0) {
    return null;
  }
  const used = Math.min(liveContext, contextWindow);
  const percentage = Math.round((used / contextWindow) * 100);
  return `${formatContextTokens(used)}/${formatContextTokens(contextWindow)} tokens (${percentage}%)`;
}
