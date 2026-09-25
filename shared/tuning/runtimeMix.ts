/**
 * Workflow runtime mix — the provider-routing core.
 *
 * The SECOND per-workflow dial, orthogonal to the tuning level
 * (`./workflowTuning.ts`). The level decides WHICH steps run and at what Claude
 * tier·effort; the mix decides WHICH PROVIDER runs each step, split along one
 * line — execution vs. verification:
 *
 *   claude          Claude executes, Claude verifies  (today's default, identity)
 *   claude-primary  Claude executes, Codex verifies
 *   codex-primary   Codex executes,  Claude verifies
 *   codex           Codex executes,  Codex verifies
 *
 * ORTHOGONAL TO THE RUNTIME ROW, too. The launch Runtime picks the run's
 * ORCHESTRATOR — the provider the run itself resolves onto — while the mix picks
 * the provider of each AGENT the flow dispatches. Neither constrains the other:
 * {@link applyRuntimeMix} states EVERY routed agent's runtime explicitly, so a
 * mixed graph runs identically under a Claude or a Codex orchestrator. (Picking
 * a mix therefore never moves the Runtime row, and picking a Runtime never
 * rewrites the mix.)
 *
 * Unlike a tuning level, the mix is materialized EXACTLY ONCE — inside
 * `createRun`'s spec freeze, via {@link materializeForLevelAndMix}. Every other
 * definition read (`resolveEffectiveDefinition`, the workflow editor, the
 * variant snapshot, `workflowMeta`, MCP `cyboflow_get_workflow`) deliberately
 * stays mix-free: `cyboflow_get_workflow`'s definition round-trips into
 * `cyboflow_update_workflow`, which persists into the custom slot, so a
 * mix-generated `runtime` pin surfacing on the read path would be
 * indistinguishable from a user-authored one, become sticky, and defeat later
 * mix flips. See `docs/plans/workflow-runtime-mix.md` D1. Display surfaces that
 * want to SHOW the routing compute it from {@link resolveEffectiveDefinitionWithMix}
 * instead of reading a materialized spec.
 *
 * Keep this file free of Node built-ins, zod, and any main/ import — it is
 * consumed by both processes, exactly like its tuning sibling.
 */

import { resolveStepAgentKey } from '../types/agentIdentity';
import type { CodexEffortLevel } from '../types/reasoningEffort';
import {
  WORKFLOW_DEFINITIONS,
  isCyboflowWorkflowName,
  resolveWorkflowDefinition,
  type CyboflowWorkflowName,
  type WorkflowAgentConfig,
  type WorkflowDefinition,
} from '../types/workflows';
import {
  applyTuningPreset,
  getTuningPreset,
  materializeForLevel,
  resolveEffectiveDefinition,
  serializeDefinition,
  type TuningLevel,
} from './workflowTuning';

// ─── Mix vocabulary ──────────────────────────────────────────────────────────

/** The four selectable runtime mixes, in display order (Claude-most to Codex-most). */
export const RUNTIME_MIXES = ['claude', 'claude-primary', 'codex-primary', 'codex'] as const;

export type RuntimeMix = (typeof RUNTIME_MIXES)[number];

/** The mix for a workflow that has never been routed — today's behaviour, byte for byte. */
export const DEFAULT_RUNTIME_MIX: RuntimeMix = 'claude';

/**
 * Display name per mix — the ONE spelling every surface uses (the wizard's
 * segments, the launch summary, a future editor dial), kept here rather than
 * per-component so a mix never reads as two different things depending on where
 * you are. Mirrors `TUNING_LEVEL_LABELS`.
 */
export const RUNTIME_MIX_LABELS: Readonly<Record<RuntimeMix, string>> = {
  claude: 'Claude only',
  'claude-primary': 'Claude primary',
  'codex-primary': 'Codex primary',
  codex: 'Codex only',
};

/** Runtime guard for an untyped value (DB column, IPC payload) being a RuntimeMix. */
export function isRuntimeMix(value: unknown): value is RuntimeMix {
  return typeof value === 'string' && (RUNTIME_MIXES as readonly string[]).includes(value);
}

/**
 * The provider that runs the EXECUTION class under `mix`.
 *
 * NOT the run's base provider: the mix and the Runtime row are ORTHOGONAL dials
 * — the Runtime picks the ORCHESTRATOR (the provider the run itself resolves
 * onto), the mix picks the provider of each AGENT the flow dispatches, and
 * {@link applyRuntimeMix} states every routed agent's runtime explicitly so the
 * two never have to agree. `createRun` consults this only as a FILL-IN for a
 * launch that named no provider at all (the backlog/idea launchers, MCP), where
 * nothing is being overridden.
 */
export function primaryProviderForMix(mix: RuntimeMix): 'claude' | 'codex' {
  return mix === 'claude' || mix === 'claude-primary' ? 'claude' : 'codex';
}

/** True for the two cross-provider mixes — one provider executes, the other verifies. */
export function isMixedRuntimeMix(mix: RuntimeMix): boolean {
  return mix === 'claude-primary' || mix === 'codex-primary';
}

// ─── Tier map: Claude pin -> Codex pin ───────────────────────────────────────

/**
 * The Codex models the tier map targets, hardcoded as named constants exactly
 * like the tuning presets hardcode Claude aliases.
 *
 * Slugs verified against the live Codex CLI catalog (codex-cli 0.156.1:
 * `gpt-6-luna` and `gpt-6-sol` both listed and turn-probed). A
 * Codex model bump is therefore a ONE-CONSTANT edit — which forks spec_hash
 * revisions for every mixed run, exactly like any preset recalibration.
 */
export const CODEX_TIER_MODELS = {
  luna: 'gpt-6-luna',
  sol: 'gpt-6-sol',
} as const;

/**
 * The rungs the tier map moves along, low-to-high. A strict subset of
 * `CODEX_EFFORT_LEVELS` — Codex's `none`/`minimal` sit below this ladder and are
 * never a mapping TARGET (nothing on Claude's scale corresponds to them), so
 * `low` is the floor and `xhigh` the ceiling.
 */
const CODEX_EFFORT_LADDER: readonly CodexEffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

/**
 * Project a Claude effort onto {@link CODEX_EFFORT_LADDER}. Claude's `max` has no
 * Codex counterpart above `xhigh`, so it clamps there; the sub-`low` values a
 * config may carry from another provider's scale (`none`, `minimal`, `off`)
 * floor at `low`; an absent or unrecognized effort is the `medium` middle.
 */
function ladderIndexForClaudeEffort(effort: string | undefined): number {
  switch (effort) {
    case 'none':
    case 'off':
    case 'minimal':
    case 'low':
      return 0;
    case 'high':
      return 2;
    case 'xhigh':
    case 'max':
      return 3;
    default:
      return 1; // medium, and the unspecified/unrecognized default
  }
}

function ladderRung(index: number): CodexEffortLevel {
  if (index <= 0) return CODEX_EFFORT_LADDER[0];
  const top = CODEX_EFFORT_LADDER.length - 1;
  return CODEX_EFFORT_LADDER[index >= top ? top : index];
}

/**
 * Krishna's calibration (design canvas, 2026-08-28) — the Claude pin a level
 * resolved, mapped to the Codex pin the mixed run should spawn with:
 *
 *   sonnet / sonnet-250k -> luna, effort MIRRORED (`max` clamps to `xhigh`)
 *   haiku                -> luna, always `low`
 *   opus / opus-250k     -> sol,  one rung DOWN (floor `low`)
 *   fable                -> sol,  one rung UP   (ceiling `xhigh`)
 *
 * Anything else — an unknown alias, or no pin at all — is treated as the
 * `sonnet`·`medium` fallback the plan specifies, which lands on luna·medium.
 * (The EARLIER fallback, the flow's Standard-preset pin, is applied by
 * {@link applyRuntimeMix} before it calls here.) Every mapped effort lands
 * inside `CODEX_EFFORT_LEVELS`. See `docs/plans/workflow-runtime-mix.md` D1.
 */
export function codexPinForClaude(
  model: string | undefined,
  effort: string | undefined,
): { providerModel: string; effort: CodexEffortLevel } {
  switch (model) {
    case 'sonnet':
    case 'sonnet-250k':
      return {
        providerModel: CODEX_TIER_MODELS.luna,
        effort: ladderRung(ladderIndexForClaudeEffort(effort)),
      };
    case 'haiku':
      return { providerModel: CODEX_TIER_MODELS.luna, effort: 'low' };
    case 'opus':
    case 'opus-250k':
      return {
        providerModel: CODEX_TIER_MODELS.sol,
        effort: ladderRung(ladderIndexForClaudeEffort(effort) - 1),
      };
    case 'fable':
      return {
        providerModel: CODEX_TIER_MODELS.sol,
        effort: ladderRung(ladderIndexForClaudeEffort(effort) + 1),
      };
    default:
      // The plan's `sonnet`·`medium` fallback — BOTH halves, so a stray effort
      // on an unpinned agent cannot drag the fallback off its calibrated rung.
      return { providerModel: CODEX_TIER_MODELS.luna, effort: 'medium' };
  }
}

// ─── Role classes ────────────────────────────────────────────────────────────

/**
 * The VERIFICATION-class agent keys per flow; everything else the definition
 * binds is execution class. This is the one table the mix routes off, so it is
 * DATA with a colocated test that resolves every key against the real built-in
 * graph — a renamed agent trips the suite instead of silently unrouting a step.
 *
 * `write-tests` is deliberately EXECUTION (canvas open decision 1: it authors
 * the diff's tests rather than judging the diff). Flipping it is a one-entry
 * edit here.
 *
 * `compound` and `verify-setup` are single-agent flows with nothing to split, so
 * their verification class is EMPTY — the two mixed segments are disabled for
 * them in the wizard, while `claude`/`codex` stay meaningful as a whole-flow
 * provider choice.
 */
export const VERIFICATION_AGENT_KEYS: Readonly<
  Record<CyboflowWorkflowName, ReadonlySet<string>>
> = {
  sprint: new Set([
    'code-review',
    'task-verify',
    'visual-verify',
    'sprint-verify',
    'sprint-review',
  ]),
  planner: new Set(['adversarial-review']),
  // Ship is planner concatenated with sprint in one run; its agent keys mirror
  // both parents exactly, so its class table is the union of theirs.
  ship: new Set([
    'code-review',
    'task-verify',
    'visual-verify',
    'sprint-verify',
    'sprint-review',
    'adversarial-review',
  ]),
  launch: new Set(['adversarial-review']),
  compound: new Set<string>(),
  'verify-setup': new Set<string>(),
};

/**
 * Does `agentKey` run on Codex for this flow × mix?
 *
 *   claude          -> never
 *   claude-primary  -> the verification class only
 *   codex-primary   -> everything EXCEPT the verification class
 *   codex           -> everything
 */
export function mixRoutesAgentToCodex(
  flow: CyboflowWorkflowName,
  mix: RuntimeMix,
  agentKey: string,
): boolean {
  if (mix === 'claude') return false;
  if (mix === 'codex') return true;
  const isVerification = VERIFICATION_AGENT_KEYS[flow].has(agentKey);
  return mix === 'claude-primary' ? isVerification : !isVerification;
}

// ─── The transform ───────────────────────────────────────────────────────────

/**
 * Every canonical agent key `def` binds, in graph order and de-duplicated —
 * outer steps and fan-out inner steps alike, resolved through
 * {@link resolveStepAgentKey} so legacy labels land on their canonical key.
 *
 * `null` results are SKIPPED: `agent: 'human'` steps are approve GATES, not
 * agents, and minting an `agentConfigs.human` entry for one would be a routing
 * pin on something that never spawns (plan D1, review finding 7).
 */
function definitionRoutableAgentKeys(def: WorkflowDefinition): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (key: string | null): void => {
    if (key === null || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  for (const phase of def.phases) {
    for (const step of phase.steps) {
      add(resolveStepAgentKey(step.id, step.agent));
      for (const inner of step.fanOut?.inner ?? []) {
        add(resolveStepAgentKey(inner.id, inner.agent));
      }
    }
  }
  return keys;
}

/**
 * Apply a runtime mix to a LEVEL-MATERIALIZED definition. PURE — `def` is never
 * mutated; the result is always a fresh structure.
 *
 * Applied AFTER the level so it sees the level's resolved tier·effort pins,
 * which are what the tier map reads. Per agent key:
 *
 *   - an existing explicit `runtime` -> SKIPPED. User routing outranks the mix;
 *     the mix fills only unpinned agents. (Level presets can never carry
 *     `runtime` — `TuningAgentPin` forbids it by construction — and since the
 *     read path never persists mix pins, every `runtime` in a custom slot really
 *     is user-authored.)
 *   - routed to CODEX -> `{ ...existing, runtime: 'codex-sdk', providerModel,
 *     effort }` from the tier map. The Claude `model` field STAYS: it is inert
 *     under a codex runtime (`providerModel` wins at every spawn seam) and it is
 *     what makes a flip back to a Claude mix lossless.
 *   - routed to CLAUDE -> `runtime: 'claude-sdk'` explicitly, `model`/`effort`
 *     untouched. Pinned on EVERY non-claude mix, not only a codex-base one:
 *     the mix is orthogonal to the run's base provider, so a `claude-primary`
 *     graph must STATE its Claude routing rather than inherit it — under a
 *     Codex orchestrator an unpinned agent would otherwise take the run's
 *     provider in `spawnStepRunner` and silently execute on Codex.
 *
 * `mix === 'claude'` returns the clone unchanged. Callers short-circuit before
 * reaching here (see {@link materializeForLevelAndMix}), but the function stays
 * total over the mix union.
 *
 * `flow` supplies the class table, so the tier·effort fallback can also consult
 * the flow's Standard preset for an agent the current level left unpinned.
 * See `docs/plans/workflow-runtime-mix.md` D1.
 */
export function applyRuntimeMix(
  def: WorkflowDefinition,
  flow: CyboflowWorkflowName,
  mix: RuntimeMix,
): WorkflowDefinition {
  const next = structuredClone(def);
  if (mix === 'claude') return next;

  const standardPins = getTuningPreset(flow, 'standard')?.agentConfigs ?? {};
  const configs: Record<string, WorkflowAgentConfig> = { ...(next.agentConfigs ?? {}) };
  let wrote = false;

  for (const agentKey of definitionRoutableAgentKeys(next)) {
    const existing = configs[agentKey];
    // Explicit user routing outranks the mix (custom-level precedence).
    if (existing?.runtime !== undefined) continue;

    if (mixRoutesAgentToCodex(flow, mix, agentKey)) {
      const pin = codexPinForClaude(
        existing?.model ?? standardPins[agentKey]?.model,
        existing?.effort ?? standardPins[agentKey]?.effort,
      );
      configs[agentKey] = {
        ...(existing ?? {}),
        runtime: 'codex-sdk',
        providerModel: pin.providerModel,
        effort: pin.effort,
      };
      wrote = true;
    } else {
      // Claude-routed: pin the substrate unconditionally. The mix no longer
      // decides the run's provider, so "inherit the run" is not a statement
      // about Claude any more — only an explicit pin is.
      configs[agentKey] = { ...(existing ?? {}), runtime: 'claude-sdk' };
      wrote = true;
    }
  }

  // Mirror `mergeAgentConfigs`' discipline: the overlay stays ABSENT when the
  // transform contributed nothing, so a no-op mix is structurally identical to
  // its input.
  if (wrote) next.agentConfigs = configs;
  return next;
}

/**
 * The RUN-side entry point: the exact `spec_json` TEXT `createRun` freezes for a
 * flow at a level under a mix. Composes {@link applyRuntimeMix} after the
 * existing `materializeForLevel` — the single site where a mix is ever
 * materialized (plan D1).
 *
 * The `'claude'` arm is a VERBATIM short-circuit through `materializeForLevel`,
 * with no parse and no re-serialize. That is load-bearing, not an optimization:
 * `materializeForLevel`'s `custom` arm returns the STORED spec text with its
 * original whitespace and key order, and a parse -> re-serialize round-trip
 * would canonicalize it and fork `spec_hash` away from every pre-mix custom run.
 * A non-claude mix on a custom level does serialize canonically — that hash fork
 * is intentional (it IS a different graph).
 *
 * A non-built-in ("save as new") flow has no class table and is outside the mix
 * system entirely, so it short-circuits the same way. So does a custom slot that
 * cannot be parsed: an unreadable spec cannot be mixed, and degrading to the
 * level-only materialization is strictly better than dropping the run's graph.
 */
export function materializeForLevelAndMix(
  name: string,
  specJson: string | null | undefined,
  level: TuningLevel,
  mix: RuntimeMix,
): string {
  if (mix === 'claude' || !isCyboflowWorkflowName(name)) {
    return materializeForLevel(name, specJson, level);
  }

  const base =
    level === 'custom'
      ? resolveWorkflowDefinition(name, specJson)
      : applyTuningPreset(WORKFLOW_DEFINITIONS[name], name, level);
  if (base === null) return materializeForLevel(name, specJson, level);

  return serializeDefinition(applyRuntimeMix(base, name, mix));
}

/**
 * The READ-side sibling of {@link materializeForLevelAndMix}, with the same
 * short-circuit semantics.
 *
 * Deliberately NOT used by the persisted-read seams (`getEffectiveDefinition`,
 * the workflow editor, the variant snapshot, MCP `cyboflow_get_workflow`) —
 * those stay mix-free by design (plan D1). This exists for the wizard's DISPLAY
 * surfaces (routing chips, the launch summary), which need to show what a mix
 * would do without a materialized spec to read it from.
 */
export function resolveEffectiveDefinitionWithMix(
  name: string,
  specJson: string | null | undefined,
  level: TuningLevel,
  mix: RuntimeMix,
): WorkflowDefinition | null {
  const base = resolveEffectiveDefinition(name, specJson, level);
  if (mix === 'claude' || !isCyboflowWorkflowName(name) || base === null) return base;
  return applyRuntimeMix(base, name, mix);
}
