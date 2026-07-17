# Config-level per-agent config for the Claude SDK substrate

**Status:** Investigated → **DEFERRED** (2026-07-17). Shipped the cheap warm-stale
alternative instead (see [Decision](#decision)).

**Scope:** whether cyboflow should deliver per-agent subagent config (model / tools /
MCP) to the Claude Agent SDK via the config-level `query({ options: { agents } })`
option instead of the filesystem `.claude/agents/*.md` overlay.

This document captures the research (SDK facts + two independent adversarial
reviews) so the decision is not re-litigated from scratch.

---

## 1. How per-agent model resolves today

cyboflow has two execution planes:

- **Orchestrated** — one top-level Claude Code `query()` runs the whole workflow and
  dispatches subagents via the **Agent** tool (renamed from `Task`;
  `shared/types/agentIdentity.ts:91` treats both as the same dispatch).
- **Programmatic** — the host (`SpawnStepRunner`) sequences the DAG; each step is its
  own fresh SDK session whose prompt is a thin driver that delegates to the
  `cyboflow-<agent>` role **via the Task tool** (`main/src/orchestrator/programmatic/stepPrompt.ts:184`).

In **both** planes the real agent work runs as a Task/Agent-dispatched **subagent**,
which reads its `.claude/agents/cyboflow-<key>.md` frontmatter — including the
`model:` line. So a per-agent Claude model pin **already takes effect today** via the
filesystem overlay; this is not a broken path.

The effective agent set is the single composition point
(`main/src/services/panels/claude/agentOverlayWriter.ts:195` `resolveRunEffectiveAgents`
→ `computeEffectiveAgents(builtins, projectOverrides)` → `applyWorkflowAgentConfigs` →
`applyVariantAgentDeltas`), materialized to `.md` by `installAgentOverlay`.
Precedence (low→high): **built-in → project `agent_overrides` → workflow `agentConfigs`
→ variant deltas.**

Model delivery specifics:
- **Claude per-agent model** rides the `.md` frontmatter via `renderAgentMarkdown` +
  `bareModelId(model, isModelUsable)`, which **strips any `[1m]` context marker**
  (`main/src/services/panels/claude/modelContext.ts:205`) — a subagent `.md` `model:`
  field cannot carry a context-window beta — and applies the pulled-model (Fable→Opus)
  availability fallback.
- **Codex per-agent model** is **already config-level**: `resolveStepAgent(runId, key)`
  (`main/src/index.ts:1745`) returns `{ runtime, codexModel }`;
  `spawnStepRunner.ts:140` sets `spawnModel = stepProvider === 'codex' ? stepAgent.codexModel : opts.model`.

**The asymmetry:** Codex per-agent model = spawn config; Claude per-agent model =
filesystem frontmatter.

---

## 2. Claude Agent SDK facts (verified against installed 0.3.201 typings)

- `Options.agents?: Record<string, AgentDefinition>` exists (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1307`).
  Call shape is `query({ prompt, options: { agents } })`, **not** literal `query({ agents })`.
- `AgentDefinition` fields: `description`, `prompt` (required); optional `tools`,
  `disallowedTools`, `model`, `mcpServers`, `skills`, `initialPrompt`, `maxTurns`,
  `background`, `memory`, `effort`, `permissionMode` (`sdk.d.ts:38`).
- `AgentDefinition.model` accepts aliases (`opus|sonnet|haiku|fable`), `'inherit'`, and
  full model ids; a subagent's model fully overrides the parent for its turns.
- **Config-level (programmatic) agents win over filesystem `.md`** of the same name —
  per docs; **not proven by local typings** (needs a real SDK/CLI probe before relying
  on it).
- **1M / context-window beta is NOT expressible per-subagent** in either mechanism
  (stripped; Anthropic issue #45169). Config-level does **not** fix this.
- Under `strictMcpConfig` (set when an MCP deny-list exists), on-disk agent-frontmatter
  MCP grants are ignored but MCP servers declared by explicitly-passed `agents`
  definitions ARE honored (`sdk.d.ts:1909`) — a config-level bonus for deny-list runs.
- Anthropic **recommends the config-level `agents` option for SDK applications**
  (atomic, no disk writes, no file-watch races, dynamic).

The SDK is resolved at 0.3.201 but both manifests declare `^0.3.201`
(`package.json`, `main/package.json`) — not hard-pinned.

---

## 3. The proposal (as reviewed)

Thread the run's effective agents into `query({ options: { agents } })` for the **SDK
substrate only** (keep `.md` for the `claude-interactive` PTY substrate and @-mention
discoverability), starting with the fields cyboflow already has (`model`, `tools`,
`mcpServers`, `prompt`, `description`). Seam: the `sdkOptions` builder in
`claudeCodeManager.ts`, fed by `resolveRunEffectiveAgents`.

Claimed wins (see corrections below): (1) provider symmetry; (2) removes the
out-of-band-edit surface; (3) unlocks per-agent `effort`/`permissionMode`/`maxTurns`.

---

## 4. Review findings (Fable + Codex, independent, code-verified)

Verdicts diverged on the headline (Fable "do it, scoped"; Codex "defer") but
**converged on the substance**:

**This is cleanup/symmetry, not a functional fix.** Per-agent Claude model already
works via subagent dispatch in both planes.

**Must-fix corrections to the plan:**
1. **Claimed win #2 is wrong.** The defensive coercion in `applyWorkflowAgentConfigs`
   (`main/src/orchestrator/agents/effectiveAgents.ts:246`) guards the **unvalidated
   workflow `spec_json`**, not on-disk `.md`. The config path reads the same spec, so
   that surface does not shrink; and `.md` must remain for PTY, so the on-disk edit
   surface doesn't shrink either.
2. **`EffectiveAgent[]` is a LOSSY source (concrete regression risk).** The built-in
   `visual-verify` agent grants the exact MCP tool
   `mcp__cyboflow__cyboflow_request_verification`
   (`main/src/orchestrator/workflows/sprint/agents/visual-verify.md:4`), but
   `parseBundledAgent`/`isCliTool` filter MCP tools out
   (`bundledAgentParser.ts:55`, `shared/types/cliTools.ts:6`), so the effective agent
   carries `enabledMcps: []`. It works today only because unmodified built-ins are
   written from lossless `rawContent` (`agentOverlayWriter.ts:239`). A naive
   `EffectiveAgent → AgentDefinition` conversion would **silently drop that tool**. A
   lossless shared projection (one source generating both markdown and SDK defs) is a
   prerequisite.
3. **Map keys must be the full `cyboflow-<agentKey>`** — Task/Agent dispatch uses that
   exact string; a bare-key map = subagent-not-found → silent fallback to
   general-purpose (total per-agent config loss).
4. **Reuse the dead-model guard** `bareModelId(model, isModelUsable)` — a naive builder
   would pass a pulled model (e.g. Fable) live.
5. **Tools/MCP translation is unverified** — frontmatter expands `enabledMcps` into
   `mcp__<server>__*` grants appended to the tools allowlist (`agentMarkdown.ts:53`);
   `AgentDefinition.tools` documents allow *names* (wildcards documented only for
   `disallowedTools`). Verify empirically or use `AgentDefinition.mcpServers`; preserve
   `isGrantableMcpServer`; map empty tools to explicit `[]` (omit = inherit-all); omit
   `model` for inherit.
6. **`effort`/`permissionMode`/`maxTurns` are NOT a free unlock** — they need DB /
   shared-types / validation / UI / resolution too, and per-agent `permissionMode`
   fights the live `canUseTool` mode gating. Not a v1 win.
7. **"PTY can't use it" is overstated** — the CLI exposes `--agents <json>`; keep files
   for PTY as a *choice* (argv size, `ps` visibility, interactive inspection), and keep
   `.md` for user-authored (non-`cyboflow-*`) agents so config never shadows them.

**Warm-session interaction (the main risk area):** Warm-SDK keeps one persistent
top-level `query()` per conversation; subagents run inside it (not separately
warm-managed). The only change is that the `agents` map joins the options fingerprint
(`computeOptionsFingerprint`, `claudeCodeManager.ts`). It must be **recomputed per turn**
and contain **no per-turn-dynamic values** (ports/tokens/timestamps in `mcpServers`) or
warm busts every turn. Object keys are recursively sorted before hashing; arrays retain
order → **sort set-like agent/MCP/tool lists** (the `listByProject` custom-agent append
order is un-`ORDER BY`'d). A mid-run agent edit at a resume turn closes the warm parent,
which can kill in-flight **backgrounded** subagents — decide accept vs. defer-respawn.

**The cheaper alternative both reviewers independently named:** if the only real
correctness gain is warm-stale agent edits, hash the rendered agent bundle (or
`resolveRunEffectiveAgents` output) into `computeOptionsFingerprint` — ~10 lines, keeps
filesystem delivery, no dual representation.

---

## 5. Decision

**Deferred the migration; shipped the cheap alternative.** The migration is cleanup +
provider symmetry, not a functional fix; its headline wins do not survive review; and it
carries the lossy-`EffectiveAgent` regression risk. The one unique correctness payoff
(warm-stale agent edits) is delivered by the fingerprint fix in commit
`fix: bust warm SDK session when the run's effective agents change` — an agentKey-sorted
digest of `resolveRunEffectiveAgents` folded into `computeOptionsFingerprint`, fail-soft,
retaining filesystem delivery. Gated by `test:unit` + `test:integration`.

---

## 6. Prerequisites if the migration is ever pursued

1. A **lossless shared projection** `toAgentDefinition(EffectiveAgent)` co-located with
   `renderAgentMarkdown`, driven by one source that preserves exact MCP tools (e.g.
   visual-verify's), with a parity test asserting both renderings agree on
   model/tools/mcps/prompt for **all built-in agents**.
2. A real **SDK/CLI probe** confirming config-level agents win over same-name filesystem
   `.md` (docs claim; not in local typings).
3. Full `cyboflow-<key>` naming; `bareModelId(isModelUsable)` model resolution; empty
   tools → explicit `[]`; MCP-grant translation verified (`tools` wildcard vs
   `mcpServers`), preserving `isGrantableMcpServer`.
4. Fingerprint: recompute per turn; no dynamic values; sort set-like lists.
5. SDK-substrate only; `.md` overlay retained for the interactive PTY substrate and
   user-authored agents; skip Codex-runtime (`runtime: 'codex-sdk'`) agents in the
   builder.
6. Because it touches `main/src/services/panels/claude/`, run `pnpm test:integration`
   (mocked-SDK itests) in addition to `pnpm test:unit`, plus parity tests covering every
   precedence layer and warm respawn on agent edits.
