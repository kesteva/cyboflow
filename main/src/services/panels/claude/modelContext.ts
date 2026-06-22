import type { SdkBeta } from '@anthropic-ai/claude-agent-sdk';

/**
 * The Claude Agent SDK beta flag that enables the 1M-token context window.
 * Sonnet 4/4.5 ONLY (per the SDK's `SdkBeta` docs).
 * @see https://docs.anthropic.com/en/api/beta-headers
 */
export const CONTEXT_1M_BETA: SdkBeta = 'context-1m-2025-08-07';

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
