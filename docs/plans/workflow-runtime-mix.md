# Workflow runtime mix — Claude only / Claude primary / Codex primary / Codex only

Design canvas: the "Runtime Mix" Claude Design artifact (2026-08-28). Sibling of
`docs/plans/workflow-tuning-levels.md` — the mix is the SECOND per-workflow dial,
orthogonal to the tuning level, and deliberately reuses the seams that feature
built: pure shared transform, per-workflow stamp + per-run override,
freeze-at-createRun, spec_hash revision bucketing. Revised once after a Codex
adversarial review (2026-08-28) — the review reshaped D1 (materialize at
createRun ONLY, never on the read path), D3 (resolve the mix before the
provider/execution ladders; reconcile instead of reject on legacy launch
surfaces), and D6 (restart provenance).

> **AMENDED 2026-08-31 — the mix is orthogonal to the launch Runtime row.**
> As shipped, D3's `reconcileMixWithProvider` step and the wizard's matching
> two-way coupling made picking `codex-primary` move the Runtime row (and with
> it the Default-model family) to Codex. They are now two independent dials: the
> **Runtime** picks the run's **orchestrator**; the **mix** picks the provider of
> each **agent** the flow dispatches. Concretely, superseding D3/D4 below:
> `reconcileMixWithProvider` is DELETED; `createRun` takes the resolved mix
> verbatim and an explicit provider never rewrites it; `applyRuntimeMix` now pins
> `runtime: 'claude-sdk'` on every Claude-routed agent under ANY non-claude mix
> (not just a codex-base one), so a materialized graph never depends on the
> provider the run itself landed on. What SURVIVES: the mix's primary still
> fills in the base provider for launchers that send no runtime at all (backlog
> / idea pickers, MCP), where nothing is being overridden; a non-claude mix still
> forces the programmatic plane; the whole mix row is still inert on an OMP/Pi
> lane and on a pinned variant.

**What it is.** Each built-in workflow gets four versions, split along one line —
execution vs. verification:

| Mix | Executes | Verifies | Launch shape |
|---|---|---|---|
| `claude` | Claude | Claude | orchestrated (today's default, byte-for-byte identity) |
| `claude-primary` | Claude | Codex | programmatic |
| `codex-primary` | Codex | Claude | programmatic |
| `codex` | Codex | Codex | programmatic (deviation from canvas — see D3) |

The tuning level keeps deciding **which steps run and at what Claude tier·effort**;
the mix decides **which provider runs each step**. Eval (3-slot jury, already
2×Claude + 1×Codex) and the human approve gate are untouched at every mix.

## D1 — A pure transform, applied ONLY at run materialization

New shared module `shared/tuning/runtimeMix.ts` (imports from `workflowTuning.ts`;
same no-Node/no-zod constraint — both processes consume it):

```ts
export const RUNTIME_MIXES = ['claude', 'claude-primary', 'codex-primary', 'codex'] as const;
export type RuntimeMix = (typeof RUNTIME_MIXES)[number];
export const DEFAULT_RUNTIME_MIX: RuntimeMix = 'claude';
export function isRuntimeMix(v: unknown): v is RuntimeMix;
export function primaryProviderForMix(mix: RuntimeMix): 'claude' | 'codex';
export function reconcileMixWithProvider(mix: RuntimeMix, provider: 'claude' | 'codex'): RuntimeMix;
```

**Where the transform runs — and where it deliberately does NOT.** The mix is
applied exactly once, inside `createRun`'s spec freeze (a new
`materializeForLevelAndMix` that composes `applyRuntimeMix` after the existing
`materializeForLevel`). Every OTHER definition read stays mix-free:

- `resolveEffectiveDefinition` / `getEffectiveDefinition`, the workflow editor,
  the variant-creation snapshot, `workflowMeta`, and the MCP
  `cyboflow_get_workflow` read all keep returning the level-resolved SOURCE
  graph, untouched. Rationale (review findings 4+5): `cyboflow_get_workflow`'s
  definition is round-trippable into `cyboflow_update_workflow`, which persists
  into the custom slot — mix-generated `runtime` pins surfacing there would be
  indistinguishable from user-authored pins, become sticky, and defeat later mix
  flips. Keeping the read path source-only means there is no derived-pin
  provenance problem at all, and no defaulted-parameter site can silently drop a
  stored mix (there is exactly one call site).
- Wizard surfaces that want to SHOW the routing (chips, summary) compute it in
  the renderer from the shared transform; they never read a mix-materialized
  spec.
- Variants snapshot the mix-free graph; a variant run stamps NULL mix (D5).

**Role classes** — per flow, an agent-key set for the verification class;
everything else the definition binds is execution class. Agent keys are
enumerated via `resolveStepAgentKey(step.id, step.agent)` skipping `null`
(review finding 7: `agent: 'human'` steps are gates, not agents — the transform
must never mint `agentConfigs.human`). Class tables get the same colocated
resolves-against-the-real-graph test the tuning presets have:

- sprint: verification = `code-review`, `task-verify`, `visual-verify`,
  `sprint-verify`, `sprint-review`; execution = `dependency-analyzer`,
  `implement`, `write-tests`, `address-review`. (`write-tests` is classed
  EXECUTION per the canvas; canvas open decision 1 — flipping it is a one-entry
  edit.)
- planner: verification = `adversarial-review`; execution = `context`,
  `ui-prototype`, `architecture`, `epics`, `tasks`.
- ship: union of both parents (keys/paths mirror them exactly, like the presets).
- launch: verification = `adversarial-review`; execution = the rest.
- compound / verify-setup: verification class EMPTY (single-agent flows) — the
  two mixed segments are disabled in the wizard for these flows; `claude`/`codex`
  stay meaningful (whole-flow provider).

**The transform** `applyRuntimeMix(def, flow, mix)` — pure, clone-first, applied
to the LEVEL-MATERIALIZED definition (so it sees the level's tier·effort pins):

- `mix === 'claude'` → **never reached**: `materializeForLevelAndMix` short-
  circuits `'claude'` through `materializeForLevel` VERBATIM before any
  parse/serialize (review finding 1: the `custom` arm returns the stored
  `spec_json` text with its original whitespace/key order — a parse→re-serialize
  round-trip would canonicalize it and fork spec_hash from every pre-mix custom
  run). A non-claude mix on a custom level does serialize canonically — that
  hash fork is intentional (it IS a different graph) and asserted in tests.
- For each agent key routed to CODEX under the mix (execution class when primary
  is codex, verification class when primary is claude, everything on `codex`):
  rewrite `agentConfigs[key]` to `{ ...existing, runtime: 'codex-sdk',
  providerModel, effort }` where `providerModel`/`effort` come from the tier map
  below applied to the entry's resolved Claude `model`/`effort` (fallback: the
  flow's Standard-preset pin, then `sonnet`·`medium`). The Claude `model` field
  stays in place — inert under a codex runtime (`providerModel` wins at every
  spawn seam) and preserves the flip-back.
- For each agent key routed to CLAUDE on a codex-base run (`codex-primary`'s
  verification class): set `runtime: 'claude-sdk'` explicitly, keeping
  `model`/`effort` — without the pin the agent would inherit the run's codex
  provider in `spawnStepRunner`. (On claude-base mixes claude-routed agents need
  no pin.) The programmatic runner honors `claude-sdk` pins on a codex-base run
  symmetrically — verified in review.
- **Custom-level precedence**: an agent whose existing config carries an explicit
  `runtime` is SKIPPED — user routing outranks the mix; the mix fills only
  unpinned agents. (Level presets can never carry `runtime`; `TuningAgentPin`
  forbids it by construction. And since the read path never persists mix pins,
  every explicit `runtime` in a custom slot really is user-authored.)

**Tier map** (Krishna's calibration, canvas comment 2026-08-28) —
`codexPinForClaude(model: AgentModelAlias, effort: ReasoningEffort)`:

| Claude | Codex model | Effort rule |
|---|---|---|
| sonnet / sonnet-250k | `gpt-5.6-luna` | mirror (same effort; `max` → `xhigh` clamp) |
| haiku | `gpt-5.6-luna` | `low` (unspecified on the canvas; assumed floor) |
| opus / opus-250k | `gpt-5.6-sol` | one rung DOWN on `low..xhigh` (medium→low, high→medium; floor `low`) |
| fable | `gpt-5.6-sol` | one rung UP (medium→high, high→xhigh; ceiling `xhigh`) |

Model slugs verified against the live Codex CLI catalog (codex-cli 0.153.3:
`gpt-5.6-luna` "fast and affordable", `gpt-5.6-sol` "latest frontier") and
verified to survive `normalizeAgentModelSelection`/`normalizeCodexModelSelection`
(review). Hardcoded named constants (`CODEX_TIER_MODELS`) exactly like the
presets hardcode Claude aliases — a Codex model bump is a one-constant edit
(which forks spec_hash revisions, same as any preset recalibration). Every
mapped effort lands inside `CODEX_EFFORT_LEVELS` (`low..xhigh`).

## D2 — Persistence: migration 128, mirroring 124

```sql
ALTER TABLE workflows
  ADD COLUMN runtime_mix TEXT NOT NULL DEFAULT 'claude'
  CHECK (runtime_mix IN ('claude','claude-primary','codex-primary','codex'));

ALTER TABLE workflow_runs
  ADD COLUMN runtime_mix TEXT
  CHECK (runtime_mix IS NULL OR runtime_mix IN ('claude','claude-primary','codex-primary','codex'));
```

127 because 125 (agent-proposal backlog kind) and 126 (level-scoped variants)
landed with the 2026-08-28 rebase; re-verify the ledger at merge per standing
practice. No backfill: the default IS today's behavior. `workflow_runs.runtime_mix`
NULL = "pre-feature, a variant run, a non-built-in flow, or an omp/pi run" —
readers treat NULL as unattributed, never as `'claude'`.

`runtime_mix` is REQUIRED on `WorkflowRow` (the same discipline as
`tuning_level` — review finding 8): every row-producing SELECT must project it —
registry lookup/list, the MCP full-row queries, plus `WorkflowCardMeta` and the
MCP compact projection's tuning metadata block. Unlike `tuning_level`, an
Advanced-editor spec save does NOT touch `runtime_mix` (the level flips to
`custom` because the spec IS the custom slot; the mix is orthogonal to what the
graph says and survives spec edits).

## D3 — createRun: resolve EARLY, reconcile, force programmatic, stamp

Ordering (review finding 2 — the original plan put this after the tuning block,
too late): the mix is resolved **immediately after the workflow row is loaded,
before the provider/runtime ladder and before `resolveExecutionModel`**, because
it feeds all three:

1. **Resolve** the launch-facing mix:
   - `opts.runtimeMix` override → rejection family mirroring
     `tuningOverrideRejection` (`invalid_mix`, `not_built_in`,
     `variant_conflict` for an explicit variant pin).
   - Variant arm (review finding 11): whenever `opts.variantId` or
     `opts.variantSpecJson` is present — INCLUDING a rotation pick, not just an
     explicit pin — the mix is `null`: the variant's graph is its own, provider
     and plane come from the variant/legacy ladders exactly as today.
   - Non-built-in flow → `null`. Requested provider `omp`/`pi` → `null`
     (single-provider lanes; wizard disables the row, server ignores the stamp).
   - Otherwise: `override ?? workflow.runtime_mix`.
2. **Reconcile with the requested provider** (review finding 3 — the wizard is
   NOT the only launch surface: the top-bar picker, the in-session launcher,
   backlog launchers, and "Run with modifications" all send their own
   provider/runtime or omit it; a hard `mix_provider_mismatch` rejection would
   break every one of them the moment a workflow saves a non-claude default).
   Instead of rejecting, the requested provider SWAPS the mix's primary while
   preserving the same/cross aspect — the exact semantics of the wizard's derived
   Runtime row, applied at the chokepoint:
   `effectiveMix = reconcileMixWithProvider(resolvedMix, requestedProvider)`
   (claude-mix + requested codex → `codex`; codex-primary + requested claude →
   `claude-primary`; no requested provider → the mix decides). Legacy surfaces
   therefore keep their meaning ("launch this on codex" still runs on codex) and
   never get rejected.
3. **Feed the ladders**: base provider/runtime = the mix's primary (when the mix
   is non-null); `resolveExecutionModel` runs as today, then a non-claude mix
   forces the result to `'programmatic'` — an EXPLICIT
   `opts.requestedExecutionModel === 'orchestrated'` is rejected with a typed
   `RuntimeMixOrchestratedError` (only raw API callers can hit it; the wizard
   hides the Mode row under a non-claude mix), while inherit/global-default
   resolutions are silently upgraded. This absorbs the manual "Switch to
   programmatic execution?" prompt for dial users.
4. **Stamp**: `runtime_mix` on the INSERT, with the same provenance ladder as
   `tuning_level` (review finding 9): variant → NULL; frozen restart →
   `opts.frozenSpec.runtimeMix` (which ALSO drives steps 2–3, so a replay routes
   like the original even if the workflow's stamp changed since); otherwise the
   effective mix.
5. The spec freeze uses `materializeForLevelAndMix(name, spec, level,
   effectiveMix ?? 'claude')` in the level arm; variant/frozenSpec arms
   untouched.

**Backstop guard** (review finding 6): the existing mixed-provider guard is
one-way (`agentProvider === 'claude'`), so a hand-pinned `claude-sdk` step on a
codex-base orchestrated run bypasses it. Make it symmetric: reject orchestrated
execution when any REACHABLE pinned runtime's provider differs from the resolved
run provider (quick-sentinel exemption retained). `MixedProviderOrchestratedError`
keeps its name/wizard handling; the message gains the codex-base case.

**Why `codex` launches programmatic (deviation from the canvas run-shape row).**
Per-agent `agentConfigs` pins are honored ONLY by the programmatic runner
(`spawnStepRunner`); the orchestrated plane's overlay writes Claude subagent
`.md` files (`agentOverlayWriter`) with no Codex equivalent — an orchestrated
Codex run would silently ignore every per-step luna/sol tier the SprintMix table
promises. Silent degradation is exactly what the mixed guard exists to prevent,
so v1 launches all three non-claude mixes programmatic. (Alternative —
orchestrated Codex with one flat model — is a strictly weaker dial; revisit only
if programmatic Codex lanes prove unreliable.)

## D4 — Wizard UI (per the approved canvas)

- **RUNTIME MIX row**: a second segmented row inside Workflow configuration,
  under the FLOW EFFORT LEVEL segments. Four segments, two-line labels
  (CLAUDE/only, CLAUDE/primary, CODEX/primary, CODEX/only); mix line below
  ("Everything on Claude, model tailored to the task and effort level." /
  "Claude executes, Codex reviews & verifies." / "Codex executes, Claude
  reviews & verifies." / "Everything on Codex, model tailored to the task and
  effort level.") + "· saved default" marker. New `RuntimeMixSelector` sibling
  of `TuningLevelSelector` (props: `value`, `disabled`, `onChange`,
  `mixedDisabled` for compound/verify-setup).
- **One derived launch route** (review finding 12 — the Runtime row is not
  cosmetic: `agentRuntime` state drives host-session creation, the launch
  payload, and an async model-family coercion effect that swaps
  `DEFAULT_CODEX_MODEL` in/out): derive a single
  `effectiveLaunchRoute = { provider, runtime, mix }` from selection + saved mix
  + `runtimeMixOverride`, and use it for host-session creation, the family
  coercion, the selectors, BOTH launch callbacks (single + batch), the summary,
  and payload construction. Picking a mix segment programmatically updates
  `agentRuntime` through the same `setAgentRuntimeByUser` path so the coercion
  effects run; clicking CLAUDE/CODEX on the Runtime row swaps the mix's primary
  preserving the aspect (`reconcileMixWithProvider` — same shared helper the
  server uses, so the two surfaces cannot drift). OMP/PI selection disables the
  mix row (ghost segments + "OMP lane — the runtime mix does not apply.") and
  the payload omits the mix.
- **State**: `runtimeMixOverride: RuntimeMix | null` mirroring
  `tuningLevelOverride` (null = follows the workflow stamp; cleared when the
  pick matches the stamp or a variant is pinned; sent only when non-null).
- **Mode row**: the workflow orchestration block (in Advanced) is additionally
  hidden when the effective mix ≠ `claude` — the plane is forced programmatic,
  nothing to choose. (Note from review: locate it by its current render site,
  not the pre-rebase line numbers.)
- **Save as default**: `workflows.setRuntimeMix` tRPC mutation mirroring
  `setTuningLevel`, wired as a second companion write in `handleSaveDefault`
  with the same undo re-stamp.
- **Default model row**: applies to primary-routed steps; scope note under a
  mixed pick ("the {secondary} verification steps follow the tier map / the
  level's pins").
- **Gate**: same built-in-workflow gate as the level selector; disabled when a
  variant is pinned.

Non-wizard launch surfaces (top-bar picker, in-session launcher, backlog
launchers, editor "Run with modifications") need NO code change: the D3
reconcile keeps their payloads meaningful. Follow-up (not v1): show the saved
mix on those surfaces.

## D5 — What is deliberately untouched

- **Eval**: jury composition and `evalDefault` (level-keyed) are mix-independent.
- **Approve gates**: human, mix-independent — and the transform can never touch
  them (`resolveStepAgentKey` returns `null` for `human`).
- **Visual verification**: FREE — `verificationAgentRunner` already routes to
  `codexQuery` on a `runtime: 'codex-sdk'` pin for the `visual-verify` agent
  key, which the transform writes when verification is codex-routed.
- **Insights**: each mix materializes distinct spec text → its own `spec_hash`
  revision, so per-mix stats separate for free. The `runtime_mix` stamp enables
  a later `selectRuntimeMixUsage` (sibling of `selectTuningLevelUsage`);
  dedicated Insights UI is out of scope for v1.
- **Variants**: a variant run stamps NULL mix (all arms, including rotation —
  D3). Level-scoped variants (migration 126) are orthogonal; mix-scoped variant
  pools are a possible follow-up, out of scope.

## D6 — Restart paths

- `runs.restart` recovery: `frozenSpec` becomes `{ specJson, tuningLevel,
  runtimeMix }` (read the stamp alongside `tuning_level`), and per D3 step 4 the
  recovered mix has PRECEDENCE over the workflow's current stamp for
  provider/plane derivation and the new stamp — a mix changed between failure
  and restart must not re-route a replayed spec (review finding 9).
- `cancelAndRestartHandler` (review finding 10): copying `runtime_mix` alone
  would mint a malformed replacement — the handler's INSERT does not copy
  `agent_provider` / `agent_runtime` / `execution_model`, and its stop path is
  Claude-only (`claudeManagerStop`). Scope for v1: copy ALL immutable routing
  stamps together (`agent_provider`, `agent_runtime`, `execution_model`,
  `model`, `runtime_mix`, alongside the existing `spec_hash` / `tuning_level`),
  and route the stop through the substrate dispatch facade so a codex-base run's
  process is actually terminated. (Longer-term this handler should go through
  `RunLauncher`/createRun validation; not this change.)

## Implementation slices

1. **Shared core** — `shared/tuning/runtimeMix.ts`: vocabulary, role classes,
   tier map, `applyRuntimeMix`, `reconcileMixWithProvider`,
   `materializeForLevelAndMix` (with the `'claude'` verbatim short-circuit).
   Tests: claude-mix BYTE-identity vs `materializeForLevel` at every level×flow
   including a non-canonical custom spec; class keys resolve against the real
   graphs and never include `human`; tier-map table incl. clamps; custom
   explicit-pin precedence; codex-primary writes `claude-sdk` pins on
   verification keys; reconcile truth table.
2. **Migration 128 + registry** — columns; `WorkflowRow.runtime_mix` required +
   every SELECT projection; `setRuntimeMix`; createRun per D3 (early resolve,
   reconcile, forcing, symmetric backstop guard, stamp ladder); IPC type parity
   both sides (docs/CODE-PATTERNS.md).
3. **Restart + tRPC** — `runs.restart` frozen recovery + precedence;
   `cancelAndRestartHandler` full-stamp copy + dispatch-facade stop;
   `workflows.setRuntimeMix`; `runs.start` `runtimeMix` input + mutual
   exclusions; `RunLauncher` pass-through (a mix override forces the baseline
   arm exactly like a level override).
4. **Wizard** — `RuntimeMixSelector`, the derived launch route, Mode-row hiding,
   save-default companion, summary row, omp/pi + variant disabling.
5. **MCP/meta surfaces** — `WorkflowCardMeta` + MCP compact projection carry the
   mix; tool descriptions updated; confirm `cyboflow_get_workflow` round-trip
   stays mix-free (test).
6. **Tests & gate** — registry createRun suite (stamp ladder, forcing,
   reconcile, guards), router suites, wizard component tests;
   `pnpm typecheck && pnpm lint`, `pnpm test:unit` over the settled tree.

Flow-editor mix dial (sibling of `TuningLevelDial`) and Insights UI are
follow-ups, not v1.

## Open items carried from the canvas

1. ~~`write-tests` classed execution~~ — **DECIDED 2026-08-28: Krishna ack'd
   execution class** (authors shipped test files; same-provider keeps the lane's
   diff coherent).
2. ~~Codex-only launches programmatic, not orchestrated~~ — **DECIDED 2026-08-28:
   Krishna ack'd programmatic** (D3 rationale stands; canvas superseded).
3. ~~`haiku → luna·low`~~ — **DECIDED 2026-08-28: Krishna ack'd luna·low.**
4. Compound/verify-setup: mixed segments disabled (empty verification class).
