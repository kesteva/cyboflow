/**
 * modelPricing — estimate the USD cost of a session's token usage from the
 * per-category breakdown (input / output / cache-write / cache-read) and the
 * model that produced it.
 *
 * Rates are the current public per-MTok list prices, resolved by model family
 * (opus / sonnet / haiku) via substring match so aliases and context-window id
 * suffixes (e.g. 'claude-opus-4-8[1m]', 'opus') all map correctly. Cache
 * pricing follows the standard multipliers: a 5-minute cache WRITE costs 1.25×
 * the input rate, a cache READ costs 0.1×.
 *
 * This is an estimate for the live session meter, not a billing figure: it uses
 * flat family rates (no long-context premium — Opus 4.8 / Sonnet 5 1M context
 * is at standard pricing) and the 5-minute cache-write tier.
 */
import type { SessionTokenBreakdown } from '../hooks/useSessionMetrics';

type ModelFamily = 'opus' | 'sonnet' | 'haiku';

/** Per-MTok list prices (USD per million tokens) by model family. */
const PER_MTOK: Record<ModelFamily, { input: number; output: number }> = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

/** Cache-write (5m) costs 1.25× input; cache-read costs 0.1× input. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/** Per-token USD rates for a model family. */
export interface ModelRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Resolve a model string to its family, or null when unrecognized. */
function modelFamily(model: string | null): ModelFamily | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return null;
}

/** Per-token rates for a model string, or null when the family is unknown. */
export function ratesForModel(model: string | null): ModelRates | null {
  const family = modelFamily(model);
  if (family === null) return null;
  const base = PER_MTOK[family];
  return {
    input: base.input / 1_000_000,
    output: base.output / 1_000_000,
    cacheWrite: (base.input * CACHE_WRITE_MULTIPLIER) / 1_000_000,
    cacheRead: (base.input * CACHE_READ_MULTIPLIER) / 1_000_000,
  };
}

/**
 * Estimate the session cost in USD from the token breakdown and model. Returns
 * null when the model is unknown (so callers can render an em-dash rather than
 * a misleadingly-priced figure).
 */
export function computeSessionCostUsd(
  breakdown: SessionTokenBreakdown,
  model: string | null,
): number | null {
  const rates = ratesForModel(model);
  if (rates === null) return null;
  return (
    breakdown.input * rates.input +
    breakdown.output * rates.output +
    breakdown.cacheWrite * rates.cacheWrite +
    breakdown.cacheRead * rates.cacheRead
  );
}

/**
 * Format a USD cost for the session meter: '—' when unknown, '<$0.01' for a
 * non-zero sub-cent total, else '$X.XX'.
 */
export function formatCostUsd(usd: number | null): string {
  if (usd === null) return '—';
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
