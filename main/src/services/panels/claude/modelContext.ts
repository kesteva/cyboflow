import type { SdkBeta } from '@anthropic-ai/claude-agent-sdk';
import { GUARDED_MODELS, guardedModelByConcreteId } from '../../../../../shared/types/modelAvailability';

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
 * PREVIOUS-generation snapshot, so a user who picks "Opus" silently runs an
 * older Opus. Pinning the alias to the current concrete id at the spawn seam
 * takes the resolution out of the SDK's hands: Opus 4.8 and Sonnet 5 are both
 * 1M-context at standard pricing.
 *
 * The families reach their 1M window differently:
 *   - Opus carries cyboflow's `[1m]` model-id suffix; the runtime reports a
 *     1,000,000 window for `claude-opus-4-8[1m]`, so the suffixed id IS the 1M
 *     model and the seam keeps it (no beta). The bare `claude-opus-4-8`
 *     (`opus-250k`) is the default-window variant.
 *   - Sonnet 5 is 1M by DEFAULT — the bare `claude-sonnet-5` id already reports a
 *     1M window, so it carries NO `[1m]` suffix and needs NO beta. Sonnet 5 has
 *     no separate 250K mode; the legacy `sonnet-250k` alias maps to the same id
 *     for back-compat (a stored picker value never strands). The older Sonnet 4.x
 *     snapshots reached 1M via the Sonnet-only {@link CONTEXT_1M_BETA} on a
 *     `[1m]`-suffixed id — that path is preserved in {@link sdkModelAndBetas} /
 *     {@link modelSupportsContext1M} for a caller that explicitly pins
 *     `claude-sonnet-4-6[1m]`, but the default `sonnet` alias no longer uses it.
 *   - Fable 5 (`claude-fable-5`) is Anthropic's frontier model and, like Sonnet 5,
 *     is 1M by DEFAULT — the bare id already reports a 1M window, so NO `[1m]`
 *     suffix and NO beta. Fable can be pulled from availability (it has been
 *     before); the availability guard ({@link applyModelAvailabilityFallback})
 *     swaps a picked-but-unavailable Fable to Opus at the spawn seam.
 *
 * Keep these in sync with the latest GA snapshots when models roll forward.
 */
const MODEL_ALIAS_TO_ID: Readonly<Record<string, string>> = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-4-8[1m]',
  'opus-250k': 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  'sonnet-250k': 'claude-sonnet-5',
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
 * Swap a RESOLVED model id for its fallback when the availability guard reports it
 * unavailable. Only guarded models (currently Fable 5 — see
 * `shared/types/modelAvailability`) are affected; every other id, plus
 * `undefined`/`'auto'`/an unrecognized concrete id, passes through unchanged.
 *
 * `isUsable` is INJECTED (the spawn managers wire it to the ModelAvailabilityService
 * singleton), so this stays a pure, unit-testable transform with no service
 * dependency. When a guarded model is unavailable, its fallback alias is resolved
 * back through {@link resolveModelAlias} so the return value is a real spawn-seam id
 * — e.g. Fable's `'opus'` fallback becomes `'claude-opus-4-8[1m]'`, which
 * {@link sdkModelAndBetas} / {@link interactiveModelArg} then translate normally.
 */
export function applyModelAvailabilityFallback(
  resolvedId: string | undefined,
  isUsable: (concreteId: string) => boolean,
): string | undefined {
  if (!resolvedId) return resolvedId;
  const guarded = guardedModelByConcreteId(resolvedId);
  if (!guarded) return resolvedId;
  if (isUsable(guarded.concreteId)) return resolvedId;
  return resolveModelAlias(guarded.fallbackAlias);
}

/**
 * Fallback model for the bundled CLI's DEFAULT model when it is unavailable — the
 * classifier-availability guard for native auto-mode.
 *
 * With NO explicit `--model` pin (a run whose model is NULL/'auto') the bundled
 * CLI selects its own default model, which the native auto-mode classifier ALSO
 * uses. cyboflow's frontier default is a guarded model (Fable 5); when it is
 * pulled, the classifier can't run and denies EVERY tool. This returns the
 * resolved fallback id of the first guarded model the availability guard reports
 * unavailable (so the spawn seam can pin a working classifier-capable model
 * instead of stranding on the dead default), else `undefined` — keep the CLI
 * default. An explicitly-pinned guarded model is already swapped by
 * {@link applyModelAvailabilityFallback}; this covers only the unpinned default.
 *
 * `isUsable` is INJECTED (the spawn managers wire it to the availability service),
 * keeping this a pure, unit-testable transform.
 */
export function resolveUnavailableDefaultModelFallback(
  isUsable: (concreteId: string) => boolean,
): string | undefined {
  for (const guarded of GUARDED_MODELS) {
    if (!isUsable(guarded.concreteId)) return resolveModelAlias(guarded.fallbackAlias);
  }
  return undefined;
}

/**
 * Whether a model id needs the {@link CONTEXT_1M_BETA} to unlock its 1M-token
 * context window.
 *
 * The beta is a Sonnet 4.x ONLY mechanism, so we gate strictly on explicit
 * `claude-sonnet-4-*` ids. Everything else returns false — including
 * `claude-sonnet-5`, whose 1M window is NATIVE (no beta), and Opus (whose 1M is
 * the `[1m]` id suffix, never the beta). `'auto'`/undefined also return false:
 * the resolved model is unknown, so requesting the Sonnet-only beta could land
 * on a non-Sonnet model and be rejected.
 *
 * Note: the bare `'sonnet'` alias is no longer special-cased here — it resolves
 * (via {@link resolveModelAlias}) to `claude-sonnet-5` before this gate is ever
 * consulted at the spawn seam, and Sonnet 5 needs no beta. This predicate only
 * matters for a caller that explicitly pins a `claude-sonnet-4-6[1m]` id, whose
 * marker {@link sdkModelAndBetas} strips into the beta. (Without it, a Sonnet 4.x
 * run reported a 200k window and the chat meter capped at 200k — FIND-2026-06-22.)
 */
export function modelSupportsContext1M(model?: string | null): boolean {
  if (!model) return false;
  const m = model.toLowerCase().trim();
  return /sonnet-4/.test(m); // claude-sonnet-4-5, claude-sonnet-4-6 — Sonnet 4.x only
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

/**
 * Resolve a model alias to its concrete current snapshot id with ANY `[1m]`
 * window marker removed — the form a subagent's `model:` frontmatter needs.
 *
 * A subagent `.md` is read by the bundled CLI but its `model:` field cannot carry
 * a context-window beta, and the `[1m]` marker is a cyboflow-internal id form, so
 * we emit the plain default-window snapshot (`opus` → `claude-opus-4-8`,
 * `sonnet` → `claude-sonnet-5`, `haiku` → `claude-haiku-4-5`). The agent editor
 * offers only bare families (no per-window choice), so "Opus" means the current
 * Opus at its default window — exactly this. `auto`/undefined pass through.
 *
 * When an optional `isUsable` predicate is supplied (the overlay writer wires it to
 * the ModelAvailabilityService), a guarded-but-unavailable pinned model — e.g. an
 * agent pinned to Fable 5 that has been pulled — is swapped for its fallback before
 * the bare id is emitted, so a subagent `.md` never writes a dead model.
 */
export function bareModelId(
  model?: string | null,
  isUsable?: (concreteId: string) => boolean,
): string | undefined {
  let resolved = resolveModelAlias(model);
  if (isUsable) resolved = applyModelAvailabilityFallback(resolved, isUsable);
  if (!resolved) return resolved ?? undefined;
  return hasContext1MSuffix(resolved) ? stripContext1MSuffix(resolved) : resolved;
}
