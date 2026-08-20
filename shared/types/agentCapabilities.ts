/**
 * Per-runtime capability flags — the UI's launch-surface special cases as DATA.
 *
 * Every flag here replaces a scattered `=== 'codex-pty'` / `=== 'codex-exec'`
 * test that a launch surface used to hand-write. The point is not tidiness: a
 * third provider's runtimes would otherwise have to be discovered and patched
 * into each of those tests one site at a time, and a site that was missed fails
 * silently (an effort control rendered for a runtime that drops the flag, a
 * runtime seeded into a picker that cannot launch it).
 *
 * {@link RUNTIME_CAPABILITIES} is an EXHAUSTIVE `Record<AgentRuntime, …>`, so a
 * runtime added to the union is a compile error until it is described here.
 *
 * Scope discipline — a flag earns its place only if a shipping UI site tests
 * for it TODAY, and every value below is derived from that site's current
 * behavior, changing nothing. Two capabilities deliberately do NOT live here
 * because they are already expressed as data elsewhere, and a second copy could
 * drift from the first:
 *   - "may run a workflow"  → {@link WORKFLOW_LAUNCHABLE_RUNTIMES}
 *   - "may be stored on a workflow_runs row" → {@link WORKFLOW_RUN_STORABLE_RUNTIMES}
 */

import { ALL_AGENT_RUNTIMES, isAgentRuntime, type AgentRuntime } from './agentRuntime';

export interface AgentRuntimeCapabilities {
  /**
   * Whether any launch picker may OFFER this runtime.
   *
   * False for two different reasons. `codex-exec` has no manager and is excluded
   * from both {@link SESSION_AGENT_RUNTIMES} and
   * {@link WORKFLOW_LAUNCHABLE_RUNTIMES}, yet remains reachable as a persisted
   * `config.defaultAgentRuntime` (hand-edited config.json) — which is exactly
   * why each seeding seam had its own `!== 'codex-exec'` test. The two `omp-*`
   * runtimes are declared ahead of their managers, and this flag is the single
   * switch that keeps a half-built provider out of every picker at once.
   */
  readonly selectableInPickers: boolean;
  /**
   * Whether a per-turn reasoning-effort selection reaches the agent.
   *
   * False for `codex-pty`: `CodexPtySpawnOptions.reasoningEffort` is accepted
   * and stored but never becomes a CLI flag, so the PTY has no turn-options
   * object to carry it (see codexPtyManager). True for `claude-sdk`
   * (`Options.effort`), `claude-interactive` (`--effort`) and `codex-sdk`
   * (`buildCodexAppServerTurnOptions`).
   */
  readonly supportsEffort: boolean;
  /**
   * Whether the Opus-only fast-mode opt-in applies.
   *
   * Claude-only — there is no Codex analogue, so every Codex runtime drops the
   * flag. Both Claude runtimes carry it: the SDK panel persists it directly and
   * the interactive eager spawn receives it on `claudeConfig.fastMode`.
   */
  readonly supportsFastMode: boolean;
}

/**
 * The capability table. Exhaustive over {@link AgentRuntime} by construction —
 * adding a runtime without describing it here fails the build.
 */
export const RUNTIME_CAPABILITIES: Readonly<Record<AgentRuntime, AgentRuntimeCapabilities>> = {
  'claude-sdk': { selectableInPickers: true, supportsEffort: true, supportsFastMode: true },
  'claude-interactive': { selectableInPickers: true, supportsEffort: true, supportsFastMode: true },
  'codex-sdk': { selectableInPickers: true, supportsEffort: true, supportsFastMode: false },
  'codex-pty': { selectableInPickers: true, supportsEffort: false, supportsFastMode: false },
  // No manager and no launch surface: every flag is off. Nothing distinguishes
  // it at a picker site (the pickers never receive it), so these values are
  // unreachable-by-construction rather than observed behavior.
  'codex-exec': { selectableInPickers: false, supportsEffort: false, supportsFastMode: false },
  // Selectable since the last Phase-1 step: both managers exist and the
  // quick-session create path routes them. Reaching OMP still requires the
  // user to switch the provider ON — `AGENT_PROVIDER_REGISTRY.omp` defaults an
  // absent access key to DISABLED, so pickers only offer these lanes after an
  // explicit opt-in in Settings → Integrations or onboarding.
  //
  // `supportsEffort` is true for omp-sdk: OMP's RPC turn options carry a
  // thinking level (OMP_EFFORT_LEVELS in ./reasoningEffort). omp-pty takes
  // codex-pty's answer for codex-pty's reason — the TUI is driven by
  // keystrokes, not a turn-options object, so an effort selection would be
  // accepted and dropped. Fast mode is the Opus-only Claude opt-in with no
  // OMP analogue.
  'omp-sdk': { selectableInPickers: true, supportsEffort: true, supportsFastMode: false },
  'omp-pty': { selectableInPickers: true, supportsEffort: false, supportsFastMode: false },
  // The fleet SUPERVISOR runtime (omp-phase4-coexistence-adr.md §3, §5): offered
  // in the quick-session picker only, and only while the bridge availability
  // probe reports configured (SubstrateSelector gates it further). The remote
  // worker owns its model and thinking level (DEFAULT_OMP_MODEL), so effort and
  // fast mode are both producer-side and hidden here.
  'omp-fleet': { selectableInPickers: true, supportsEffort: false, supportsFastMode: false },
};

/**
 * What an UNREGISTERED runtime is assumed to support: nothing. A runtime string
 * that matches no entry can only come from a surface outside the type system (a
 * hand-edited config.json, a stale persisted value), and the safe reading of
 * "Cyboflow has never heard of this" is "offer it nothing" — a picker that
 * silently omits an unknown runtime beats one that throws mid-render.
 */
const NO_CAPABILITIES: AgentRuntimeCapabilities = {
  selectableInPickers: false,
  supportsEffort: false,
  supportsFastMode: false,
};

/**
 * The capability record for a value read off an UNTYPED surface — a persisted
 * config field, an IPC payload. A typed `AgentRuntime` can index
 * {@link RUNTIME_CAPABILITIES} directly; this is the guarded form, falling back
 * to {@link NO_CAPABILITIES} for anything unregistered.
 */
export function runtimeCapabilitiesForValue(
  runtime: string | null | undefined,
): AgentRuntimeCapabilities {
  return isAgentRuntime(runtime) ? RUNTIME_CAPABILITIES[runtime] : NO_CAPABILITIES;
}

/**
 * True when a launch picker may offer `runtime`. Deliberately accepts anything a
 * persisted field can hold: every call site reads a value that may be absent (an
 * unset `config.defaultAgentRuntime`, an unresolved stored default) or, via a
 * hand-edited config.json, unrecognized. Both read as "not selectable", matching
 * the `!== undefined && !== 'codex-exec'` pairs this replaces.
 */
export function isRuntimeSelectableInPickers(runtime: string | null | undefined): boolean {
  return runtimeCapabilitiesForValue(runtime).selectableInPickers;
}

/** True when a per-turn reasoning-effort selection reaches `runtime`. */
export function runtimeSupportsEffort(runtime: AgentRuntime): boolean {
  return RUNTIME_CAPABILITIES[runtime].supportsEffort;
}

/** True when the Opus fast-mode opt-in applies to `runtime`. */
export function runtimeSupportsFastMode(runtime: AgentRuntime): boolean {
  return RUNTIME_CAPABILITIES[runtime].supportsFastMode;
}

/**
 * Every runtime carrying `capability`, in {@link ALL_AGENT_RUNTIMES} order.
 * Exists for tests and for a future picker that wants to enumerate rather than
 * filter; keeps the iteration order single-sourced.
 */
export function runtimesWithCapability(
  capability: keyof AgentRuntimeCapabilities,
): AgentRuntime[] {
  return ALL_AGENT_RUNTIMES.filter((runtime) => RUNTIME_CAPABILITIES[runtime][capability]);
}
