import type { SdkBeta } from '@anthropic-ai/claude-agent-sdk';

/**
 * The Claude Agent SDK beta flag that enables the 1M-token context window.
 * Sonnet 4/4.5 ONLY (per the SDK's `SdkBeta` docs). `claude-sonnet-4-6` —
 * which {@link resolveModelAlias} pins the bare `'sonnet'` alias to — also
 * matches the `/sonnet-4/` gate in {@link modelSupportsContext1M}, so the beta
 * still applies after pinning.
 * @see https://docs.anthropic.com/en/api/beta-headers
 */
export const CONTEXT_1M_BETA: SdkBeta = 'context-1m-2025-08-07';

/**
 * Concrete, current model ids for cyboflow's bare aliases.
 *
 * The bundled Claude Agent SDK (0.2.x) resolves a bare alias like `'opus'` to a
 * PREVIOUS-generation snapshot (e.g. `opus` → Opus 4.7, `sonnet` → a 250k-window
 * Sonnet), so a user who picks "Opus" silently runs 4.7 and a "Sonnet · 1M"
 * label is contradicted by the actual 250k window. Pinning the alias to the
 * current concrete id at the spawn seam takes the resolution out of the SDK's
 * hands: Opus 4.8 and Sonnet 4.6 are both 1M-context at standard pricing.
 *
 * Keep these in sync with the latest GA snapshots when models roll forward.
 */
const MODEL_ALIAS_TO_ID: Readonly<Record<string, string>> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

/**
 * Resolve a user-facing model alias to the concrete current snapshot id, so the
 * spawn pins the model instead of delegating alias resolution to the SDK (which
 * lags a generation — see {@link MODEL_ALIAS_TO_ID}).
 *
 * Pass-through (returned unchanged) for: `undefined`/empty, `'auto'` (the SDK
 * owns model choice), and any value that is already a concrete id or an
 * unrecognized string. Matching is case/space-insensitive on the bare alias
 * ONLY — a value like `'claude-opus-4-7'` is left exactly as the caller pinned it.
 */
export function resolveModelAlias(model?: string | null): string | undefined {
  if (!model) return model ?? undefined;
  const key = model.toLowerCase().trim();
  return MODEL_ALIAS_TO_ID[key] ?? model;
}

/**
 * Whether a model id/alias supports the 1M-token context window via
 * {@link CONTEXT_1M_BETA}.
 *
 * The beta is Sonnet 4/4.5 ONLY, so we gate strictly: cyboflow's bare `'sonnet'`
 * alias (which the SDK resolves to the latest Sonnet 4.x) and explicit
 * `claude-sonnet-4-*` ids qualify. Everything else returns false —
 * `'auto'`/undefined (the resolved model is unknown, so requesting the
 * Sonnet-only beta could land on a non-Sonnet model and be rejected), `'opus'`,
 * `'haiku'`, and Sonnet 3.x ids.
 *
 * Without this gate, a Sonnet run reports a 200k context window and the chat
 * context meter caps at 200k even though the model is 1M-capable (FIND-2026-06-22).
 */
export function modelSupportsContext1M(model?: string | null): boolean {
  if (!model) return false;
  const m = model.toLowerCase().trim();
  if (m === 'sonnet') return true; // bare alias → latest Sonnet (4.x)
  return /sonnet-4/.test(m); // claude-sonnet-4-5, claude-sonnet-4-6, …
}
