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
 * The `[1m]` model-id suffix is cyboflow's UNIFORM "request the 1M window"
 * marker on a resolved id. The two model families reach 1M differently, so the
 * spawn seam ({@link sdkModelAndBetas} / {@link interactiveModelArg}) translates
 * the marker per-family: Opus's 1M IS the suffixed id (the runtime reports a
 * 1,000,000 window for `claude-opus-4-8[1m]`), whereas Sonnet's 1M rides the
 * Sonnet-only {@link CONTEXT_1M_BETA} applied from the bare `claude-sonnet-4-6`
 * id. The `-250k` variants resolve to the bare id with NO marker → default
 * window, and the seam emits no beta for them.
 *
 * Keep these in sync with the latest GA snapshots when models roll forward.
 */
const MODEL_ALIAS_TO_ID: Readonly<Record<string, string>> = {
  opus: 'claude-opus-4-8[1m]',
  'opus-250k': 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6[1m]',
  'sonnet-250k': 'claude-sonnet-4-6',
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

/** The `[1m]` marker {@link MODEL_ALIAS_TO_ID} stamps on a resolved id for 1M. */
const CONTEXT_1M_SUFFIX = '[1m]';

/** Whether a resolved id carries the 1M-window marker. */
export function hasContext1MSuffix(id?: string | null): boolean {
  return typeof id === 'string' && id.toLowerCase().trim().endsWith(CONTEXT_1M_SUFFIX);
}

/** The bare concrete id with any `[1m]` marker removed. */
function stripContext1MSuffix(id: string): string {
  return id.replace(/\[1m\]\s*$/i, '').trim();
}

/**
 * Translate a resolved model id into the SDK `model` + `betas` for its requested
 * context window. Opus's 1M IS the suffixed id (kept as-is, no beta); Sonnet's 1M
 * is the bare id + {@link CONTEXT_1M_BETA} (the SDK doesn't take a `[1m]` Sonnet
 * id, so the marker is stripped and turned into the beta). No marker → bare id,
 * no beta (the default/250k window). `auto`/undefined pass straight through.
 */
export function sdkModelAndBetas(
  resolvedId?: string | null,
): { model: string | undefined; betas: SdkBeta[] } {
  if (!resolvedId) return { model: resolvedId ?? undefined, betas: [] };
  if (!hasContext1MSuffix(resolvedId)) return { model: resolvedId, betas: [] };
  const bare = stripContext1MSuffix(resolvedId);
  if (modelSupportsContext1M(bare)) return { model: bare, betas: [CONTEXT_1M_BETA] };
  return { model: resolvedId, betas: [] };
}

/**
 * The `--model` arg for the interactive CLI. The CLI has no 1M-beta path, so a
 * `[1m]` Sonnet id would be an unknown model — strip the marker (Sonnet stays at
 * the default window interactively, as it always has). Opus's `[1m]` id is a real
 * model the CLI accepts, so it is kept. `auto`/undefined pass through.
 */
export function interactiveModelArg(resolvedId?: string | null): string | undefined {
  if (!resolvedId) return resolvedId ?? undefined;
  if (hasContext1MSuffix(resolvedId) && modelSupportsContext1M(stripContext1MSuffix(resolvedId))) {
    return stripContext1MSuffix(resolvedId);
  }
  return resolvedId;
}
