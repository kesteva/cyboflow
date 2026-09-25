/**
 * primaryModelUsage — pick the session's MAIN model out of a `result` event's
 * `modelUsage` map (camelCase SDK field, keyed by model id).
 *
 * `modelUsage` is NOT single-model: Claude Code runs its own side queries
 * (titles, summaries, classifiers) on Haiku, and those land in the same map —
 * often FIRST. Taking the first entry with a `contextWindow` made a 1M Opus run
 * read "of 200k ctx" (2026-09-22: `{ 'claude-haiku-4-5-20251001': 200000,
 * 'claude-opus-5-5[1m]': 1000000 }`).
 *
 * The rule is "largest `contextWindow` wins": the helper model is never given a
 * wider window than the model the session runs on, and for equal windows the
 * choice cannot change the denominator. Ties keep the earlier entry.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The `modelUsage` entry with the largest positive `contextWindow`, or null when
 * `modelUsage` is absent/malformed or no entry reports a window.
 */
export function primaryModelUsageEntry(modelUsage: unknown): Record<string, unknown> | null {
  if (!isRecord(modelUsage)) return null;
  let best: Record<string, unknown> | null = null;
  let bestWindow = 0;
  for (const modelData of Object.values(modelUsage)) {
    if (!isRecord(modelData)) continue;
    const cw = modelData.contextWindow;
    if (typeof cw !== 'number' || !(cw > 0)) continue;
    if (cw > bestWindow) {
      best = modelData;
      bestWindow = cw;
    }
  }
  return best;
}

/** The main model's context window from a `modelUsage` map, or null. */
export function primaryModelContextWindow(modelUsage: unknown): number | null {
  const entry = primaryModelUsageEntry(modelUsage);
  return entry ? (entry.contextWindow as number) : null;
}
