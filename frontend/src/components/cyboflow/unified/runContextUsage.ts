/**
 * Live context-usage deriver for a WORKFLOW RUN's structured stream.
 *
 * Quick SDK sessions get their context-% string from the backend
 * (main/src/events.ts → ClaudePanelState.contextUsage). That extractor
 * DELIBERATELY skips cyboflow run ids (events.ts: `if (isCyboflowRunId(...))
 * return`), so a flow run never has a server-side contextUsage to read. Instead
 * we compute it on the renderer from the same `streamEvents` log RunChatView
 * already consumes — reactive by construction (it recomputes as events append).
 *
 * The %-meter needs two numbers that arrive on DIFFERENT event types:
 *   - the DENOMINATOR (`contextWindow`, e.g. 200000) only appears in `result`
 *     events' `modelUsage.<model>.contextWindow` (cyboflow's typed `system/init`
 *     carries no window). So the meter stays "--%" until the first `result`.
 *   - the NUMERATOR (current prompt size) updates more often, on each
 *     `assistant` event's `message.usage` — the sum of the disjoint token
 *     partitions input + cache_read + cache_creation ≈ the live context size.
 * We keep the last-seen window and the latest used count; an `assistant` event
 * after the last `result` reflects the in-flight turn against the prior window.
 *
 * Returns a string parseable by {@link parseContextUsage} ("128k/200k tokens
 * (64%)"), or null when there is not yet enough info (→ ChatMetaStrip "--%").
 */
import type { StreamEvent } from '../../../utils/cyboflowApi';

/** Format a token count like the backend extractor: ">=1000 → Nk". */
function formatTokenCount(count: number): string {
  return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

export function deriveRunContextUsage(events: readonly StreamEvent[]): string | null {
  let contextWindow = 0;
  let used = 0;

  for (const ev of events) {
    if (ev.type === 'assistant') {
      const u = ev.payload.message.usage;
      if (u) {
        const n =
          (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
        if (n > 0) used = n;
      }
      continue;
    }

    if (ev.type === 'result') {
      const mu = ev.payload.modelUsage;
      if (mu === undefined) continue;
      // modelUsage is keyed by model name; take the first model that reports a
      // context window (the run is single-model in practice). camelCase fields
      // are the documented wire casing — see ResultEvent in claudeStream.ts.
      for (const modelData of Object.values(mu)) {
        if (modelData === null || typeof modelData !== 'object') continue;
        const m = modelData as Record<string, unknown>;
        const cw = m.contextWindow;
        if (typeof cw !== 'number' || cw <= 0) continue;
        contextWindow = cw;
        const input = typeof m.inputTokens === 'number' ? m.inputTokens : 0;
        const cacheRead = typeof m.cacheReadInputTokens === 'number' ? m.cacheReadInputTokens : 0;
        const cacheCreation =
          typeof m.cacheCreationInputTokens === 'number' ? m.cacheCreationInputTokens : 0;
        const n = input + cacheRead + cacheCreation;
        if (n > 0) used = n;
        break;
      }
    }
  }

  if (contextWindow <= 0 || used <= 0) return null;
  const clamped = Math.min(used, contextWindow);
  const percent = Math.round((clamped / contextWindow) * 100);
  return `${formatTokenCount(clamped)}/${formatTokenCount(contextWindow)} tokens (${percent}%)`;
}
