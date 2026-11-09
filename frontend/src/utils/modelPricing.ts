/**
 * modelPricing — estimate the USD cost of a session's token usage from the
 * per-category breakdown (input / output / cache-write / cache-read) and the
 * model that produced it.
 *
 * Rates are per-MTok list prices keyed by model GENERATION, not just family: within
 * one family the price moves between versions (Opus 5.5 is $4/$20 where Opus 5 is
 * $5/$25; Fable 5.2 is $8/$40 where Fable 5.1 is $10/$50), and the cache-read rate
 * is no longer a flat 0.1× of input (Opus 5.5 reads cache at $0.20, 0.05×). The
 * figures mirror the bundled Claude Code CLI's own pricing tiers. A concrete id
 * (`claude-opus-4-8[1m]`, `claude-haiku-4-5-20251001`) is parsed to family + version
 * and looked up most-specific first; a picker alias (`opus`) or a version this table
 * does not list prices as its family's CURRENT model.
 *
 * This is an estimate for the live session meter, not a billing figure: no
 * long-prompt premium (Haiku 5.5 bills prompts over 100K tokens higher) and the
 * 5-minute cache-write tier only.
 */
import type { SessionTokenBreakdown } from '../hooks/useSessionMetrics';
import { claudeModelFamily, type AgentModelAlias } from '../../../shared/types/agents';

/** Per-MTok list prices (USD per million tokens). */
interface PerMTok {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const tier = (input: number, output: number, cacheWrite: number, cacheRead: number): PerMTok => ({
  input,
  output,
  cacheWrite,
  cacheRead,
});

const FABLE_5_2 = tier(8, 40, 10, 0.2);
const FABLE_5_1 = tier(10, 50, 12.5, 0.25);
const FABLE_5 = tier(10, 50, 12.5, 1);
const OPUS_5_5 = tier(4, 20, 5, 0.2);
const OPUS_5 = tier(5, 25, 6.25, 0.5);
const OPUS_4_1 = tier(15, 75, 18.75, 1.5);
const SONNET_5_5 = tier(2, 10, 2.5, 0.1);
const SONNET_5 = tier(2, 10, 2.5, 0.2);
const SONNET_4 = tier(3, 15, 3.75, 0.3);
const HAIKU_5_5 = tier(0.1, 0.5, 0.125, 0.01);
const HAIKU_4_5 = tier(1, 5, 1.25, 0.1);

/**
 * Generation tiers keyed `family-major[-minor]`. Lookup tries `family-major-minor`,
 * then `family-major`, so `opus-4-0` falls to `opus-4` and `sonnet-4-6` to `sonnet-4`.
 * Mythos shares Fable's prices.
 */
const BY_VERSION: Readonly<Record<string, PerMTok>> = {
  'fable-5-2': FABLE_5_2,
  'fable-5-1': FABLE_5_1,
  'fable-5': FABLE_5,
  'mythos-5-2': FABLE_5_2,
  'mythos-5-1': FABLE_5_1,
  'mythos-5': FABLE_5,
  'opus-5-5': OPUS_5_5,
  'opus-5': OPUS_5,
  'opus-4-8': OPUS_5,
  'opus-4-7': OPUS_5,
  'opus-4-6': OPUS_5,
  'opus-4-5': OPUS_5,
  'opus-4': OPUS_4_1,
  'opus-3': OPUS_4_1,
  'sonnet-5-5': SONNET_5_5,
  'sonnet-5': SONNET_5,
  'sonnet-4': SONNET_4,
  'sonnet-3': SONNET_4,
  'haiku-5-5': HAIKU_5_5,
  'haiku-4': HAIKU_4_5,
};

/**
 * The model each picker alias runs today, so an alias (or an unlisted version)
 * prices like it. Keep in step with `MODEL_ALIAS_TO_ID` in
 * `shared/agents/modelContext.ts` — note `haiku` still pins Haiku 4.5.
 */
const FAMILY_CURRENT: Readonly<Record<AgentModelAlias, PerMTok>> = {
  fable: FABLE_5_2,
  opus: OPUS_5_5,
  sonnet: SONNET_5_5,
  haiku: HAIKU_4_5,
};

/**
 * `claude-<family>-<major>[-<minor>]` (current naming) or `claude-<major>[-<minor>]-<family>`
 * (Claude 3 naming). A minor is one or two digits, so a date suffix is never read as one.
 */
const NEW_STYLE_ID = /claude-(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/;
const OLD_STYLE_ID = /claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)/;

function perMTokForModel(model: string): PerMTok | null {
  const m = model.toLowerCase();
  let parsed: { family: string; major: string; minor: string | undefined } | null = null;
  const nu = NEW_STYLE_ID.exec(m);
  if (nu) parsed = { family: nu[1], major: nu[2], minor: nu[3] };
  else {
    const old = OLD_STYLE_ID.exec(m);
    if (old) parsed = { family: old[3], major: old[1], minor: old[2] };
  }
  if (parsed) {
    const { family, major, minor } = parsed;
    const hit =
      (minor !== undefined ? BY_VERSION[`${family}-${major}-${minor}`] : undefined) ??
      BY_VERSION[`${family}-${major}`];
    if (hit) return hit;
    if (family === 'mythos') return FABLE_5_2;
  }
  // The shared family derivation (also used by the per-step model rail), so an
  // alias or an unlisted version prices as that family's current model.
  const family = claudeModelFamily(model);
  return family === null ? null : FAMILY_CURRENT[family];
}

/** Per-token USD rates for a model. */
export interface ModelRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Per-token rates for a model string, or null when the family is unknown. */
export function ratesForModel(model: string | null): ModelRates | null {
  if (!model) return null;
  const base = perMTokForModel(model);
  if (base === null) return null;
  return {
    input: base.input / 1_000_000,
    output: base.output / 1_000_000,
    cacheWrite: base.cacheWrite / 1_000_000,
    cacheRead: base.cacheRead / 1_000_000,
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
