# Cyboflow Workflows + Agents Pane — Final Implementation Plan

> Source: dynamic planning workflow (`plan-workflows-agents-pane`, 17 agents) grounded in and adversarially verified against the live tree. Verify phase produced 53 findings (5 blockers, 17 high), all folded in below. Recreates the design handoff `Cyboflow MVP (1).zip` (look/typography/layout authoritative; its SoloFlow data model discarded).

## 1. Summary

We are building a new top-level **Workflows** management pane — a stacked gallery (a Workflows card grid over an Agents card grid) reached from a new **Workflows** primary left-rail entry (mirroring Insights / Human-review), plus a full-window **Agent editor** modal. The design handoff is authoritative for look/typography/layout only; its data model (old SoloFlow 5-flow / agent-library catalogue) is discarded.

**The three settled product decisions** are: (1) **Agents are fully editable** via a new per-project override layer — a new DB table + migration storing per-project agent overrides (system prompt + tools + description) and per-project custom agents, merged into each run's worktree `.claude/agents/` at spawn; editing a shared agent applies in-place to every workflow in that project that references it, while "Duplicate / Save as a copy" mints a custom agent. (2) **Agents stay model-agnostic** — no per-agent model field; agents inherit the run's model; the editor shows model read-only as "inherits run model" (no 3-model picker). (3) **New workflow uses a template gallery** — "New workflow" first opens a `GalleryNew` picker (duplicate an existing flow as a template, or start blank), then hands off to the existing blueprint `WorkflowEditorModal` in create mode seeded with the chosen definition.

**Canonical agent-identity decision (the central architectural choice):** the canonical agent key (`agentKey`) is **the bundled agent's file basename** — the stem of each `cyboflow-<key>.md` (equivalently the frontmatter `name:` with the `cyboflow-` prefix stripped; a P1 test asserts the two agree). There are **13** keys: `context, research, epics, tasks, dependency-analyzer, implement, code-review, write-tests, task-verify, sprint-verify, visual-verify, sprint-review, compounder`. This single key is used by (i) `WorkflowStep.agent` (re-pointed in P0), (ii) the Agents catalogue + gallery, (iii) the override store column `agent_overrides.agent_key`, and (iv) the spawn-time filename `cyboflow-<key>.md`. **`human` is a gate, not an agent** — excluded from the catalogue/store/editor but retained as a valid `step.agent` value in the blueprint editor's select.

## 2. Architecture decisions & invariants

### 2.1 Settled cross-area conflict resolutions

- **C1 — Canonical identity = file basename, not parsed frontmatter (corrects HIGH-36).** `agentKey` is the bundle logical name (`workflowBundle.ts` derives it via `basename(entry,'.md')`) and the writer's filename stem (`cyboflow-<basename>.md`). The catalogue is *parsed* from each `.md`, but it keys by basename and a P1 test asserts `frontmatter.name === 'cyboflow-' + basename` for all 13 files (catalogue-can't-drift guard, stronger than a bare `name === cyboflow-+key`). Pre-existing runtime note (not introduced here, not in scope): the orchestrator prose dispatches `subagent_type:"compounder"` (unprefixed basename) while the SDK matches the prefixed frontmatter `name:` — documented as a pre-existing fact, untouched.

- **C2 — `step.agent` resolution is per-STEP, not per-LABEL (corrects BLOCKER-4, HIGH-6).** `step.agent` is persisted to `workflow_runs.steps_snapshot_json` as `{stepId: label}` for progress attribution only; no runner dispatches on it. Because `task-refiner` is the agent on **both** the `epics` step (`workflows.ts:330`) and the `tasks` step (`workflows.ts:338`), a value-only alias map cannot disambiguate them. Therefore the resolver is **step-aware**: `resolveStepAgentKey(stepId, label)`. Going forward, `WORKFLOW_DEFINITIONS` is re-pointed to canonical keys (P0). Old runs are **never migrated**; their frozen snapshots resolve at read time, disambiguating by `stepId` (which already equals the canonical key for `epics`/`tasks`). Back-compat is **best-effort** for the planner refine phase (an old `epics`-step snapshot resolves correctly via its step id; a bare label out of step context is lossy — documented).

- **C3 — Override table shape.** Project-scoped (NOT workflow-scoped: a worktree has one `.claude/agents/` dir, so the SDK cannot host two `cyboflow-implement.md`). Final columns (migration 028), including `description` (corrects HIGH-11):
  ```sql
  CREATE TABLE IF NOT EXISTS agent_overrides (
    id            TEXT PRIMARY KEY,                 -- 'ago_<10b hex>'
    project_id    INTEGER NOT NULL,
    agent_key     TEXT NOT NULL,                    -- canonical basename key
    base_agent_key TEXT,                            -- NULL = custom; else builtin key it shadows (== agent_key)
    name          TEXT NOT NULL,                    -- frontmatter name (display)
    role          TEXT,                             -- 'planner'|'sprint'|'compound' (custom: free)
    description   TEXT NOT NULL,                    -- frontmatter description (SDK auto-select; validated /cyboflow_/-free)
    system_prompt TEXT NOT NULL,                    -- markdown body
    tools_json    TEXT NOT NULL,                    -- JSON CliTool[] (NOT comma string)
    is_custom     INTEGER NOT NULL DEFAULT 0,       -- 0|1
    version       INTEGER NOT NULL DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, agent_key),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_agent_overrides_project ON agent_overrides(project_id);
  ```
  **The `enabled` column is DROPPED for MVP (corrects LOW-53):** `resetOverride` (delete row → bundled default re-applies) is the disable path. No `enabled` overlay branch, no affordance-less column.

- **C4 — Tools vocabulary, one source.** `shared/types/cliTools.ts`: `CLI_TOOLS = ['Read','Edit','Write','Bash','Grep','Glob','WebSearch','WebFetch']`, `CliTool` type, `isCliTool` guard. `tools_json` stores `CliTool[]`. Distinct from workflow-step `mcps[]` — never conflated.

- **C5 — `tools_json` is JSON** (`JSON.stringify(CliTool[])`), parsed once in the effective-entry builder; the frontmatter writer re-joins with `, ` only at spawn.

- **C6 — Shared merge.** Both the tRPC router (`buildEffectiveEntry` → `AgentEntry`) and the spawn overlay (`computeEffectiveAgents` → `EffectiveAgent`) consume the same parsed-builtin map (`loadBuiltInAgents()`) and the same override rows, through one `mergeAgent(builtin, override)` helper. Output shapes differ only in framing (`AgentEntry` adds `usage`/`stats`; `EffectiveAgent` adds `source`).

- **C7 / honest-limitation split (corrects HIGH-38).** Two distinct inert-ness causes, surfaced separately in UI copy:
  1. **Custom agents** (`is_custom=1`) — written to the worktree but **never auto-dispatched** by built-in prose (no `subagent_type:` references them). Available only via `@`-mention. UI: "available to @-mention, not auto-dispatched by this flow."
  2. **Builtin overrides of prose-only agents** (`code-review`, `write-tests`, `task-verify`, `visual-verify`) — **fully effective at runtime** (the prose dispatches `cyboflow-<key>`; the overlay overwrites the file). Their step-usage count is 0 only because no `step.agent` points at them. UI: "edits take effect on every <workflow> run" — NOT "not bound by a step."

- **C8 — `verifier → sprint-verify`; usage partition corrected (corrects HIGH-17, HIGH-18).** The only step bearing `agent:'verifier'` is the `sprint-verify` step (`workflows.ts:404`), so `verifier→sprint-verify` and **sprint-verify has usage 1**. The only step bearing `agent:'code-reviewer'` is the `sprint-review` step (`workflows.ts:412`), so `code-reviewer→sprint-review` and **sprint-review has usage 1**. Corrected partition: **bound (usage ≥ 1, 9 keys)** = `context, research, epics, tasks, dependency-analyzer, implement, sprint-verify, sprint-review, compounder`; **step-unbound (usage 0, 4 keys)** = `code-review, write-tests, task-verify, visual-verify`. There is exactly one alias table in `shared/types/agentIdentity.ts`, used by both display and usage computation.

- **C9 — Catalogue derives from `.md` at boot** (memoized), never hand-maintained. A unit test asserts `loadBuiltInAgents().size === 13`, `frontmatter.name === 'cyboflow-'+basename` per file, and `CANONICAL_AGENT_KEYS` deep-equals the sorted catalogue keys (single source of truth; corrects LOW-51).

- **C10 — Run routes into the wizard by ROW ID, scoped to the card's project (corrects HIGH-16).** Each row is project-scoped, so `entry.row.project_id` is the unambiguous lock target. But `preselectWorkflowName` matches by name inside the locked project, which collides for cross-project custom flows and silently falls back to `DEFAULT_WORKFLOW_NAME='sprint'`. Fix: carry `preselectWorkflowId` (the row id). Run → `goToWizard({ lockProjectId: entry.row.project_id, preselectWorkflowId: entry.row.id })`. The seed idea/tasks are chosen **in** the wizard via the existing `IdeaPickerModal`/`TaskBatchPickerModal` (no pre-seeding from the gallery; corrects HIGH-15).

### 2.2 Invariants

- **I1 — Single-writer (agents never call `cyboflow_*`), enforced over the FULL rendered file (corrects HIGH-12).** `validateAgentDraft` rejects `/cyboflow_/` in the **assembled markdown** (frontmatter `description` + body), not just `system_prompt`. `CLI_TOOLS` excludes all `cyboflow_*` MCP tools and `Task`. The editor never offers them. Server-side enforced.

- **I2 — `workflowBundle.builtins.test.ts` stays green AND a NEW overlay-content test guards rendered output (corrects MEDIUM-25).** The existing contract test reads SOURCE only and is therefore *not* evidence the overlay is safe — it is trivially green regardless. P1 adds a new test that runs `assertAgentShape`-equivalent regexes (`/^---[\s\S]*name:[\s\S]*description:[\s\S]*tools:/`, contains `## Result`, NOT `/cyboflow_/`) over `renderAgentMarkdown` output for an override and a custom.

- **I3 — All `agent_overrides` writes funnel through `AgentOverrideRouter.applyChange` — but it does NOT write `entity_events` (corrects BLOCKER-1/2/3).** `entity_events.entity_type` has a hard CHECK `IN ('idea','epic','task','review_item')` (`015:147`); inserting `'agent_override'` throws `SQLITE_CONSTRAINT` and rolls back every write. Agent overrides are project-scoped **config**, not board entities — the analogy to `TaskChangeRouter`/`ReviewItemRouter` is partial (they log there because their entities *are* board rows; `workflows`/`workflow_revisions` config tables do NOT touch `entity_events`). The chokepoint still serializes (per-project `PQueue(1)`), transaction-wraps the write, and emits post-commit on the EventEmitter. **No `entity_events` row, no CHECK widening, no table rebuild.** Audit history, if ever wanted, is a future dedicated table — out of scope.

- **I4 — Migration number = 028.** Verified: 027 is highest, no gaps (003–027 all present; the memory-cited 022/023/025/026/027 are on disk). `CREATE TABLE IF NOT EXISTS`, `IF NOT EXISTS` indexes, no explicit `BEGIN/COMMIT` (wrapped by `runFileBasedMigrations`), validation in code not CHECK constraints (mirrors 016/026). `project_id INTEGER` + FK→`projects(id) ON DELETE CASCADE` is type-correct (verified `projects.id` INTEGER).

- **I5 — No `any`.** `unknown` + guards or narrow generics. ESLint `no-explicit-any` is error.

- **I6 — tRPC parity + subscription inference.** Frontend imports `AgentEntry` etc. from `shared/types/agents.ts`; router explicit return types propagate via `AppRouter` inference — no local mirror in the renderer (`AgentGalleryEntry` is a deliberate view-model adapter at the store seam). `onChanged` uses `onData: (event) => …` inference. Pure tRPC (no `IPCResponse`).

- **I7 — Both substrates overlay, via the SHARED install seam (corrects MEDIUM-31).** The overlay is installed as a sibling step inside the existing single substrate-shared seam `installWorkflowBundle` (`workflowBundleInstall.ts`), called by BOTH managers — not hand-mirrored into `claudeCodeManager.ts` and `interactiveClaudeManager.ts` separately. This structurally guarantees: (a) both substrates inherit it from one source, eliminating drift; (b) it runs strictly *after* the bundle writer's `write()` (which calls `remove()` first), so it cannot be wiped. `installWorkflowBundle` is synchronous/void (corrects MEDIUM-41) — the overlay's async fs work is added as `installAgentOverlay(...)` awaited immediately after, inside an already-async wrapper exposed by the seam.

- **I8 — Overlay is the FULL writer of the effective agent set, not a delta patch (corrects BLOCKER-5, HIGH-9).** Custom/duplicated/template-derived workflows insert `workflow_path = NULL`, so `resolveWorkflowBundle(null)` returns `EMPTY_BUNDLE` and writes zero agent files — there is nothing for an override to overwrite, and the flow's referenced builtin agents would be absent (`subagent_type:"cyboflow-implement"` fails). Therefore the overlay writes, into `<worktree>/.claude/agents/`, **the entire effective set** = (every builtin from `loadBuiltInAgents()`, catalogue-derived, independent of `workflow_path`) ⊕ (overrides) ⊕ (customs). This runs after the bundle write; for built-in flows it re-asserts the same builtins (idempotent), for custom flows it supplies them. Decision: quick sessions (which today get no bundle) **do** receive the full builtin set + the project's overrides/customs via this same seam, so `@`-mentioning a (overridden) agent works.

- **I9 — Escaping user-authored `.md`.** `renderAgentMarkdown` emits frontmatter in pinned order `name → description → tools` (matches the `assertAgentShape` regex and all 13 source files; corrects LOW-43); `description` YAML-escaped (double-quote-wrap + escape `"`/`\` when it contains `:`/`#`/leading-`"`); `tools` joined from validated `CliTool[]`; body verbatim but body-opening-`---` rejected at validation; kebab-validated key keeps filenames path-safe. Round-trips through `bundledAgentParser` (P1 test).

- **I10 — Nav mutual exclusion is total: all 11 sibling-clearing `set(...)` sites carry `workflowsOpen:false` (corrects HIGH-13, LOW-49).** The 11 sites in `navigationStore.ts` are: `goHome`, `goToWizard`, `goToSession`, `navigateToProject`, `navigateToSessions`, `openHumanReview`, `toggleHumanReview`, `openBacklog`, `toggleBacklog`, `openInsights`, `toggleInsights`. Each gets `workflowsOpen:false`; the new `openWorkflows`/`toggleWorkflows`/`closeWorkflows` set the other three false.

### 2.3 Back-compat for existing runs
No data migration. `steps_snapshot_json` stays frozen on disk. Legacy labels resolve at read time via the **step-aware** `resolveStepAgentKey(stepId, label)` at **both** frontend display sites and **backend** label resolvers (`taskListing.resolveAgentLabel`, `taskChangeRouter.resolveAgentLabel`, `mcpQueryHandler` actor string) — corrects HIGH-7/HIGH-10. The two backend resolvers stay byte-identical per their existing drift comment.

---

## Phase dependency sequence

```
P0  shared identity + types + WORKFLOW_DEFINITIONS remap + ALL display/backend normalization sites
 ├─ P1  migration 028 + router chokepoint (NO entity_events) + tRPC agents router + FULL-set spawn overlay (shared seam)
 │       ├─ P2  frontend nav + gallery + PhaseRibbon (Agents section feature-gated on P1/P3)
 │       └─ P3  agent editor modal (incl. description field)
 └─ P4  template-create flow + cross-project Run routing (by workflowId)
```
Build order: **P0 → P1 → (P2 ∥ P3) → P4.** P0 must land strictly before P4 (templated builtin defs must carry canonical keys).

---

## P0 — Agent-identity reconciliation + shared types

**Goal:** one canonical key, one step-aware alias resolver, one tools vocabulary, `WORKFLOW_DEFINITIONS` re-pointed, all display **and backend** sites normalized. No DB, no runtime behavior change beyond display labels.

### Files created
- `shared/types/agentIdentity.ts`
  ```ts
  export const CANONICAL_AGENT_KEYS = ['context','research','epics','tasks','dependency-analyzer',
    'implement','code-review','write-tests','task-verify','sprint-verify','visual-verify',
    'sprint-review','compounder'] as const;
  export type CanonicalAgentKey = (typeof CANONICAL_AGENT_KEYS)[number];
  export const HUMAN_GATE_AGENT = 'human';

  // Step-aware: (stepId,label) -> canonical key. Only real legacy step.agent values appear here.
  // Authored from the verified live set; phantom 'visual-verifier'/'test-writer' are NOT included
  // (they never appeared in any shipped WORKFLOW_DEFINITIONS). See P0 AC for the source-validity test.
  const LEGACY_BY_LABEL: Readonly<Record<string,string>> = {
    'idea-extractor':'context','researcher':'research',
    'executor':'implement','verifier':'sprint-verify','code-reviewer':'sprint-review',
    // 'task-refiner' is intentionally absent here — it is dual-binding; resolved by stepId below.
  };
  // stepId already equals the canonical key for the ambiguous planner refine steps.
  const STEP_DISAMBIGUATED = new Set(['epics','tasks']);

  /** Display + usage resolver. Returns null for the human gate. */
  export function resolveStepAgentKey(stepId: string, label: string): string | null {
    if (label === HUMAN_GATE_AGENT) return null;
    if (label === 'task-refiner' && STEP_DISAMBIGUATED.has(stepId)) return stepId; // epics|tasks
    return LEGACY_BY_LABEL[label] ?? label; // identity for already-canonical
  }
  /** Pure display when only a label is available (lossy for task-refiner). */
  export function normalizeAgentLabel(label: string): string {
    return LEGACY_BY_LABEL[label] ?? label;
  }
  export function isCanonicalAgentKey(s: string): s is CanonicalAgentKey {
    return (CANONICAL_AGENT_KEYS as readonly string[]).includes(s);
  }
  ```
  > Phantom entries removed (corrects HIGH-19). The map sources are exactly the verified legacy `step.agent` universe.
- `shared/types/cliTools.ts` — `CLI_TOOLS` (8 tools), `CliTool`, `isCliTool` (C4).
- `shared/types/agents.ts` — pinned shapes (corrects LOW-47):
  ```ts
  export interface AgentUsage { workflowCount: number; usedBy: Array<{ workflowName: string; stepNames: string[]; phaseColor: string }>; }
  export interface AgentStats { model: 'inherits run model'; estPromptTokens: number; costUsd: null; lastEditedAt: string | null; toolsEnabled: number; toolsTotal: number; }
  export interface AgentEntry {
    agentKey: string; name: string; role: 'planner'|'sprint'|'compound'|string;
    description: string; systemPrompt: string; tools: CliTool[];
    source: 'builtin'|'builtin-override'|'custom';
    isCustom: boolean; isOverridden: boolean;
    usage: AgentUsage; stats: AgentStats;
  }
  ```
- `shared/types/agentCatalogue.ts` — `BuiltinAgentMeta` *type* surface (`{ key; displayName; role; description; tools: CliTool[]; sourceBasename }`). The *value* is produced at boot by P1's `loadBuiltInAgents` — no hardcoded prompt bodies here.

### Files modified
- `shared/types/workflows.ts` — re-point 10 `step.agent` values (`human` ×4 unchanged): `idea-extractor→context` (:296), `researcher→research` (:305), `task-refiner→epics` (:330), `task-refiner→tasks` (:338), `dependency-analyzer` unchanged (:374), `executor→implement` (:389), `verifier→sprint-verify` (:404), `code-reviewer→sprint-review` (:412), `compounder` ×3 unchanged (:447, :455, :472).
- `frontend/src/components/cyboflow/workflowEditorOptions.ts` — `AGENT_OPTIONS = [...CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT]` (corrects HIGH-20, MEDIUM-23/26: keeps `human` selectable for gate steps). Keep free-text fallback. `MCP_OPTIONS`/`PHASE_COLORS` unchanged.
- `frontend/src/components/cyboflow/WorkflowStepCard.tsx:101` — replace `step.agent.split('-')[0]` with a non-truncating short-label (full normalized key with CSS truncation, or strip a known phase prefix) so `sprint-verify` and `sprint-review` stay distinct (corrects HIGH-8). Wrap with `resolveStepAgentKey(step.id, step.agent)` for the resolved key.
- Frontend display sites wrap with `resolveStepAgentKey(step.id, step.agent)`: `WorkflowProgressTimeline.tsx`, `WorkflowEditorCanvas.tsx` (grep `step.agent` in `frontend/src/components/cyboflow`; verify exact lines on touch).
- **Backend resolvers (added per HIGH-7/HIGH-10), kept byte-identical per their drift comment:** `main/src/orchestrator/taskListing.ts:250` `resolveAgentLabel` and `main/src/orchestrator/taskChangeRouter.ts:1435` `resolveAgentLabel` both apply `resolveStepAgentKey(run.current_step_id, snapshot[run.current_step_id])`; `main/src/orchestrator/mcpQueryHandler.ts` `agent:${label}` actor string normalized the same way (audit downstream `agent:` consumers, or normalize at write time — documented).

### Acceptance criteria
- AC-P0-1: every `WORKFLOW_DEFINITIONS` `step.agent` ∈ `CANONICAL_AGENT_KEYS ∪ {'human'}`.
- AC-P0-2: `resolveStepAgentKey('epics','task-refiner')==='epics'`, `resolveStepAgentKey('tasks','task-refiner')==='tasks'`, `resolveStepAgentKey('sprint-verify','verifier')==='sprint-verify'`, `resolveStepAgentKey('sprint-review','code-reviewer')==='sprint-review'`, `resolveStepAgentKey(anyStep,'human')===null`, `resolveStepAgentKey('execute-tasks','executor')==='implement'`.
- AC-P0-3: every SOURCE key in `LEGACY_BY_LABEL` is a real (current or former shipped) `step.agent` value — assert no phantom labels (`visual-verifier`/`test-writer` absent).
- AC-P0-4: `AGENT_OPTIONS` deep-equals `[...CANONICAL_AGENT_KEYS, 'human']`.
- AC-P0-5: `WorkflowStepCard` renders distinct labels for `sprint-verify` vs `sprint-review` (no first-hyphen collision).

### Verification gate
`pnpm typecheck` + `pnpm test:unit` (identity tests run in main + frontend vitest). Schema parity unaffected (no DB).

---

## P1 — Backend: migration + override chokepoint + tRPC agents router + full-set spawn overlay

**Goal:** persist + serve + apply agent overrides. P2/P3 freeze against its `agents.*` shape.

### Files created

**Persistence**
- `main/src/database/migrations/028_agent_overrides.sql` — DDL per C3 (no `enabled`, includes `description`). Header documents: canonical-basename identity, model-agnostic (no model column), `human` never a key, validation in code not CHECK, transaction-wrapped by `runFileBasedMigrations` (no BEGIN/COMMIT), `IF NOT EXISTS`.
- `main/src/database/models.ts` (modified) — add `AgentOverrideRow` with the exact C3 columns (`base_agent_key: string|null`, `description: string`, `is_custom: number /*0|1*/`, `tools_json: string`; no `enabled`).

**Catalogue + merge (shared by router and overlay — C6/C9)**
- `main/src/orchestrator/agents/bundledAgentParser.ts` — `parseBundledAgent(md): ParsedBundledAgent { name; description; tools: CliTool[]; body }` (frontmatter split `^---\n([\s\S]*?)\n---\n([\s\S]*)$`; tools `split(',').map(trim).filter(isCliTool)`).
- `main/src/orchestrator/agents/agentCatalogue.ts` — `loadBuiltInAgents(): Map<string,BuiltInAgent>` (memoized; reads the 13 `.md` via `resolveWorkflowBundle` per-workflow-dir, parses, keys by **basename**, infers `role` from owning dir). `BuiltInAgent { agentKey; name; role; description; systemPrompt; tools: CliTool[] }`.
- `main/src/orchestrator/agents/effectiveAgents.ts` — `mergeAgent(builtin, override)` (total-replace), `computeEffectiveAgents(builtins, overrides): EffectiveAgent[]`, `EffectiveAgent { key; name; role; description; tools; systemPrompt; source }`. Consumed by both router and overlay.
- `main/src/orchestrator/agents/agentUsage.ts` — `computeAgentUsage(workflows): Map<string,AgentUsage>` walking each resolved def's steps via `resolveStepAgentKey(step.id, step.agent)`, accumulating per-workflow step names; `human` skipped. **Plus a prose-dispatch pass (corrects MEDIUM-37):** greps each workflow's prose `.md` for `cyboflow-<key>` / `subagent_type:"<key>"` to populate a separate `dispatchedBy` set so the 4 step-unbound agents are not falsely shown as "0 workflows." The inspector renders "Bound to N steps" + "Dispatched by: …".
- `main/src/orchestrator/agents/agentValidation.ts` — `validateAgentDraft(draft, {isCustom}): void | throws AgentOverrideError` with codes `forbidden_writer_call | forbidden_tool | empty_tools | empty_description | invalid_key | reserved_key | duplicate_key | frontmatter_in_body | version_conflict`. Rules: **reject `/cyboflow_/` in the FULL rendered markdown** (frontmatter `description` + body, per I1/HIGH-12), not just `system_prompt`; reject tools ∉ `CLI_TOOLS`; reject empty tools; require non-empty `description`; kebab key `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`; `createCustom` rejects key ∈ `CANONICAL_AGENT_KEYS` (`reserved_key`) or existing project key (`duplicate_key`); reject body opening with `---`; auto-append a `## Result` stub **with guidance** (`## Result\n<!-- Return a concise summary of what you did/found; the orchestrator records this. -->`) if absent — not a rejection (corrects LOW-44).

**Chokepoint**
- `main/src/orchestrator/agentOverrideRouter.ts` — `AgentOverrideRouter` mirroring `TaskChangeRouter`/`ReviewItemRouter` structurally (per-project `PQueue(1)`, transaction-wrapped write, post-commit emit on `agent-override-project-<projectId>` + `agent-override-all`) **but with NO `entity_events` write** (I3/BLOCKER-1/2/3). Surface:
  ```ts
  listByProject(projectId: number): AgentOverrideRow[];
  getByKey(projectId: number, agentKey: string): AgentOverrideRow | null;
  applyChange(projectId, change: AgentOverrideChange): Promise<{ agentKey: string }>;
  // ops: 'upsert' | 'createCustom' | 'reset' | 'deleteCustom'
  ```
  Every write calls `validateAgentDraft` first. `reset` deletes the override row. **`deleteCustom` is referential-integrity-guarded (corrects MEDIUM-40):** if the key appears in any workflow's `spec_json` steps, throw `CONFLICT` listing the referencing workflow names. `duplicate` is a thin wrapper over `createCustom(seed = effective source)` — one chokepoint, not two write paths (corrects LOW-53).

**tRPC**
- `main/src/orchestrator/trpc/routers/agents.ts` — `protectedProcedure`, zod inputs, explicit return types, guard `ctx.agentOverrideRouter && ctx.workflowRegistry` → `PRECONDITION_FAILED`:

  | proc | input | returns |
  |---|---|---|
  | `list` | `{projectId}` | `AgentEntry[]` |
  | `get` | `{projectId, agentKey}` | `AgentEntry` (NOT_FOUND) |
  | `upsertOverride` | `{projectId, agentKey, name, description, systemPrompt, tools:CliTool[], role?}` | `AgentEntry` |
  | `resetOverride` | `{projectId, agentKey}` | `AgentEntry` (BAD_REQUEST if custom; NOT_FOUND if no override) |
  | `createCustom` | `{projectId, name, description, role?, systemPrompt, tools}` | `AgentEntry` (CONFLICT on key collision) |
  | `duplicate` | `{projectId, agentKey, newName}` | `AgentEntry` (seeds effective source) |
  | `deleteCustom` | `{projectId, agentKey}` | `{ok:true}` (BAD_REQUEST if builtin; CONFLICT if referenced) |
  | `onChanged` | `{projectId}` | subscription `AsyncGenerator<AgentChangedEvent>` on `agent-override-project-<projectId>` |

  `tools` validated by `z.array(z.enum(CLI_TOOLS)).min(1)`; key by `z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)`. All return the post-write effective `AgentEntry` (incl. `isCustom`, `isOverridden`, `description`) in one round-trip.

**Spawn overlay (FULL writer — I8)**
- `main/src/services/panels/claude/agentOverlayWriter.ts` — `installAgentOverlay(db, runId|sessionId, worktreePath, logger): Promise<void>` + `renderAgentMarkdown(effective): string`. Resolves `project_id`, computes the **full effective set** (every builtin from `loadBuiltInAgents()` ⊕ overrides ⊕ customs), and writes `<worktree>/.claude/agents/cyboflow-<key>.md` for **every** member, AFTER the bundle write. Never calls `remove()`/clears. `renderAgentMarkdown` per I9 (pinned `name→description→tools`, escaped `description`, validated body).

### Files modified
- `main/src/services/panels/claude/workflowBundleInstall.ts` — add `installAgentOverlay` as a sibling step in the **shared seam**, run after the bundle `write()`, so both managers inherit it (I7/MEDIUM-31). The seam's public function exposes an async wrapper; `installWorkflowBundle` itself stays synchronous/void (do NOT await it — corrects MEDIUM-41).
- `main/src/orchestrator/trpc/router.ts` — insert `agents: agentsRouter,` as the **FIRST** entry in the `cyboflow` router object (alpha: `agents` < `approvals`; corrects MEDIUM-29/LOW-52). One placement, no alternatives.
- `main/src/orchestrator/trpc/context.ts` — add `agentOverrideRouter?: AgentOverrideRouterLike` to `ContextDeps` + `Context`, threaded through `createContext` (narrow interface, mirrors `workflowRegistry?`).
- `main/src/index.ts` — construct + inject the `AgentOverrideRouter` singleton (shared `EventEmitter` + `db`).
- `main/src/database/__tests__/entitySchemaParity.test.ts` — add an explicit `AgentOverrideRow field names match agent_overrides columns` case (corrects HIGH-21/LOW-45): a `buildDb` that exec's 028 + `Array<keyof AgentOverrideRow>` compared to `PRAGMA table_info(agent_overrides)`. (`scripts/verify-schema-parity.js` does NOT cover row↔column — it is a fresh-vs-upgrade drift check; the gate text below cites the correct test.)

### Acceptance criteria
- AC-P1-1: migration 028 applies on a fresh DB and a 027 DB; table + `UNIQUE(project_id, agent_key)` exist; re-run is a no-op.
- AC-P1-2: `loadBuiltInAgents().size === 13`; for each file `frontmatter.name === 'cyboflow-'+basename`, `tools ⊆ CLI_TOOLS`, `description` non-empty; `CANONICAL_AGENT_KEYS` deep-equals sorted catalogue keys; every alias target ∈ catalogue (C9).
- AC-P1-3: `agents.list` on a fresh project returns 13 builtins (`source:'builtin'`, `isOverridden:false`, `stats.costUsd===null`). **Corrected usage partition (C8):** bound (workflowCount ≥ 1) = `context, research, epics, tasks, dependency-analyzer, implement, sprint-verify, sprint-review, compounder`; step-unbound (workflowCount 0) = `code-review, write-tests, task-verify, visual-verify` — each of these 4 carries a non-empty `dispatchedBy` (e.g. `sprint`).
- AC-P1-4: `upsertOverride` → `isOverridden:true` + new prompt/tools/description + `lastEditedAt` non-null, persisted; `resetOverride` reverts; `createCustom` → `source:'custom'`, `workflowCount:0`; `duplicate` seeds from effective; `deleteCustom` removes; builtin-`deleteCustom`/custom-`resetOverride` → `BAD_REQUEST`; key collision → `CONFLICT`; **deleting a custom referenced by a workflow step → `CONFLICT`** with the referencing names.
- AC-P1-5: validation — `cyboflow_create_task` in body OR description → `forbidden_writer_call`; tool outside vocab → `forbidden_tool`; empty description → `empty_description`; non-kebab key → `invalid_key`; `createCustom` with a builtin key → `reserved_key`; missing `## Result` → guided stub appended (no throw); body opening with `---` → `frontmatter_in_body`.
- AC-P1-6 (**both substrates, full set**): a **custom workflow** run (`workflow_path NULL`) writes the builtin agents it references (e.g. `cyboflow-implement.md`) into the worktree; a built-in run with an `implement` override writes the override body AFTER the bundle write; a custom `cyboflow-foo.md` appears; `resetOverride` then re-spawn restores the bundled file. Exercised on SDK + interactive.
- AC-P1-7: `renderAgentMarkdown` round-trips through `bundledAgentParser` (exactly one frontmatter block, `name→description→tools` order, a `description` containing `:` is YAML-safe).
- AC-P1-8: **NEW overlay-content test (I2)** — `assertAgentShape`-equivalent regexes over rendered override + custom markdown (`/^---[\s\S]*name:[\s\S]*description:[\s\S]*tools:/`, contains `## Result`, NOT `/cyboflow_/`); a poisoned description (`cyboflow_create_task`) is rejected at validation.
- AC-P1-9: every procedure throws `PRECONDITION_FAILED` when deps unwired; `onChanged` fires after each write; **no `entity_events` row is created by any agent-override write** (assert `entity_events` count unchanged across an upsert).
- AC-P1-10: existing `workflowBundle.builtins.test.ts` stays green (SOURCE untouched) — necessary but NOT sufficient; AC-P1-8 is the overlay guard.
- AC-P1-11: `entitySchemaParity` `AgentOverrideRow` ↔ `agent_overrides` column-name parity passes.

### Verification gate
`pnpm rebuild better-sqlite3` (host-Node ABI) then `pnpm --filter main test` + `pnpm test:unit` (AC gate — migration/router/overlay/catalogue/validation/usage + the new `entitySchemaParity` case + the overlay-content test). `pnpm typecheck`. The contract test (AC-P1-10) and the new overlay-content test (AC-P1-8) are both in `test:unit`.

---

## P2 — Frontend: nav entry + cross-project store + gallery + PhaseRibbon

**Goal:** the Workflows rail entry and stacked gallery render real data. Agents section feature-gated.

### Files created
- `frontend/src/stores/workflowsStore.ts` — cross-project store mirroring `insightsStore` (idempotent `init`, `loading` only on first init, stale-on-error with a first-failure message string, 2s-debounced refresh, `projectFilter: number|null`). **Bounded fan-out (corrects MEDIUM-22):** `lastUsedAt` derived from **ONE `runs.list` per project** (grouped client-side by `workflow_id`), NOT per-workflow; when `projectFilter===null` enumerate `API.projects.getAll()` then per-project `workflows.list` + `agents.list` + one `runs.list`. `WorkflowGalleryEntry { row; definition; meta; lastUsedAt; projectName }`; `AgentGalleryEntry` is the view-model adapter (C6/I6 seam). **Subscriptions:** `events.onRunStatusChanged` (no input) + **one `agents.onChanged({projectId})` per enumerated project** (corrects LOW-48), torn down on filter change; payloads `AppRouter`-inferred, used only as debounce triggers.
- `frontend/src/components/workflows/WorkflowsView.tsx` — cross-project shell (no `projectId` prop), owns `init()` + `ProjectFilter` + loading/error strip + editor/create modal orchestration. **Empty/loading/error states (corrects MEDIUM-42):** no-projects → CTA to create a project; builtin-only project → the 3 builtin flow cards + New card (never truly empty); first-load skeleton; stale-on-error banner with retry; partial fan-out failure mirrors `insightsStore`'s first-failure-message contract.
- `frontend/src/components/workflows/GalleryStacked.tsx`, `GallerySection.tsx`, `WorkflowCard.tsx`, `NewWorkflowCard.tsx`, `AgentCard.tsx`, `NewAgentCard.tsx`, `PhaseRibbon.tsx`, `wfMeta.ts`. Semantic Tailwind tokens; phase fills inline `style.backgroundColor` literal hex; hover shadow `0 2px 0 var(--color-text-primary)`.
- Tests: `__tests__/wfMeta.test.ts`, `__tests__/PhaseRibbon.test.tsx`; navigationStore mutual-exclusion cases appended.

### Files modified
- `frontend/src/stores/navigationStore.ts` — add `workflowsOpen` (init `false`) + `openWorkflows`/`closeWorkflows`/`toggleWorkflows`; add `workflowsOpen:false` to **all 11** sibling-clearing `set(...)` sites (I10): `goHome`, `goToWizard`, `goToSession`, `navigateToProject`, `navigateToSessions`, `openHumanReview`, `toggleHumanReview`, `openBacklog`, `toggleBacklog`, `openInsights`, `toggleInsights`. Add `preselectWorkflowId?: string` to `WizardOpts` (C10).
- `frontend/src/App.tsx` — 2 selectors (`showWorkflows`, `toggleWorkflows`), 2 Sidebar props, 1 center-switch rung **after `showInsights`, before `showBacklog`** with a **full `ErrorBoundary` fallback** (corrects MEDIUM-32): `) : showWorkflows ? (<ErrorBoundary fallback={(error) => (/* 'Workflows error — restart app', structure identical to siblings */)}><WorkflowsView /></ErrorBoundary>) : showBacklog ? (`.
- `frontend/src/components/Sidebar.tsx` — 2 **optional** props with safe defaults (corrects MEDIUM-33): `workflowsActive?: boolean = false`, `onToggleWorkflows?: () => void`; call via `onClick={() => onToggleWorkflows?.()}`. One rail `<button>` below the Insights entry, byte-identical structure: `data-testid="workflows-rail-item"`, `aria-pressed={workflowsActive}`, active style `border-border-emphasized bg-surface-primary` + inline `boxShadow:'inset 3px 0 0 var(--color-interactive-primary)'`, **a concrete lucide icon** `<Workflow className="h-3 w-3" strokeWidth={2} />` added to the existing `lucide-react` import line (corrects MEDIUM-34 — not inline svg), title "Workflows", subtitle "Flows & agents". Badge omitted in v1.

### Key shapes
`PhaseRibbon({definition, thin?})` — **purely presentational (corrects LOW-50):** props are `definition + thin` only, NO `runId`, NO `useWorkflowPhaseState` subscription, NO filled/current state (so it does not open one subscription per gallery card). `flexGrow: max(1, phase.steps.length)` + `flexBasis:0` (width ∝ step count — fixes `FlowProgress`'s `flex-1` equal-width). Literal-hex fill; `thin` → 8px label-less. `wfMeta(def): {steps,phases,human,loops}`. `AgentGalleryEntry { id; name; role; description; tools; isCustom; isOverride; tokensEstimate: number|null }`.

### Acceptance criteria
- AC-P2-1 (mutual exclusion, both directions): after `toggleWorkflows()` all of humanReview/backlog/insights are false; for **each** of the 11 sibling-clearing actions, `workflowsOpen` ends false (unit test, mirroring the existing insights reverse-exclusion cases).
- AC-P2-2: clicking the rail item swaps center to `WorkflowsView` with the inset-rust active style; clicking another primary entry tears it down.
- AC-P2-3 (`wfMeta`): correct on planner/sprint/compound.
- AC-P2-4 (PhaseRibbon): a 3-step phase is 3× a 1-step phase; abbreviates PLAN/REFINE/EXEC/REVIEW/COMP/PRUNE with 5-char fallback; `thin` renders 8px label-less; **renders without a `runId` and opens no subscription**.
- AC-P2-5: two sections with count pills = grid item count (excluding the dashed New card); project filter narrows both grids; `null` shows all projects with a `projectName` chip; **no-projects and partial-fan-out-failure states render per the `insightsStore` failure-message contract**.
- AC-P2-6: AgentCard shows read-only "inherits run model" chip (no model picker); `tokensEstimate==null` → empty footer slot (no fabricated number); Agents section feature-gates to an empty-state if `agents.list` unavailable.

### Verification gate
`pnpm test:unit` (frontend: wfMeta, PhaseRibbon, navigationStore all-11). `pnpm typecheck` (catches `AppRouter` inference on `agents.list`/`onChanged`). Visual via `pnpm dev` + Peekaboo `visual_macos` (the `visual_web`/Playwright path is non-functional).

---

## P3 — Agent editor modal

**Goal:** full-window editor for builtins (override) + customs (create), with usage inspector. Includes the `description` field.

### Files created
- `frontend/src/components/cyboflow/agents/AgentEditorModal.tsx` — chrome + ink/paper title bar + Duplicate/Cancel/Save + `Reset to default` (shown only when `isOverridden && !isCustom`) + dirty guard + `actionInFlightRef` latch (from `WorkflowEditorModal.tsx:100`). Props `{ isOpen; projectId; agentKey; mode:'edit'|'create'; onClose; onSaved }`.
- `frontend/src/components/cyboflow/agents/AgentEditorForm.tsx` — Identity (name read-only for builtins / editable for customs; **Description field — required, editable for both override and custom, validated `/cyboflow_/`-free; corrects HIGH-11**; role chip via `ROLE_COLOR`) → System prompt hero textarea (no `{{var}}` chips) → Tools whitelist (2-col `Switch` grid over the 8 `CLI_TOOLS`, "N of M enabled"). **No model block in the form;** model appears only as a Stats key/value.
- `frontend/src/components/cyboflow/agents/AgentUsageInspector.tsx` — "**Bound to N steps**" list + "**Dispatched by: planner/sprint/compound**" line (corrects MEDIUM-37/HIGH-38, so step-unbound prose agents never show a bare "0 workflows") + Stats (Model = inherits run model, Prompt ~N tokens est., Tools n of m, Last edited) + the case-specific note: builtins → "Edits apply to every workflow that references this agent"; custom → "Available to @-mention, not auto-dispatched by built-in flows."
- `frontend/src/components/cyboflow/agents/useAgentEditorState.ts` — reducer + `dirty`; `AgentDraft { name; description; role; systemPrompt; enabledTools: CliTool[] }` (corrects HIGH-11: includes `description`); actions `SEED`/`SET_NAME`/`SET_DESCRIPTION`/`SET_SYSTEM_PROMPT`/`TOGGLE_TOOL`.
- `frontend/src/components/cyboflow/agents/agentEditorTokens.ts` — re-export `CLI_TOOLS`; **`ROLE_COLOR` maps the workflow-role to an EXISTING `--color-phase-*` var (corrects MEDIUM-39):** `planner→--color-phase-plan`, `sprint→--color-phase-execute`, `compound→--color-phase-compound` (no `--color-phase-planner`/`-sprint` exist); `estimateTokens(s)=Math.ceil(s.length/4)`.
- `__tests__/AgentEditorModal.test.tsx`.

### Key shapes
Save → `agents.upsertOverride.mutate({projectId, agentKey, name, description, systemPrompt, tools: enabledTools, role?})`; Duplicate → `FlowNameDialog` → `agents.duplicate.mutate({projectId, agentKey, newName})` → `onSaved(newKey)`; Reset → `agents.resetOverride.mutate(...)` → re-seed. Seed from `agents.get.query({projectId, agentKey})` → `AgentEntry` (carries `isCustom`/`isOverridden`/`description`/`usage`). `dirty = JSON.stringify(draft) !== JSON.stringify(baseline)`.

### Acceptance criteria
- AC-P3-1: Edit on a builtin renders prompt + description + checked tools; name/role read-only; usage line shows "bound to N / dispatched by …" (never a bare 0 for prose-dispatched agents).
- AC-P3-2: Save disabled until a field changes; fires `upsertOverride` once even on double-click (latch); then `onSaved` + close.
- AC-P3-3: Duplicate opens the name dialog; confirm → `duplicate`; cancel holds no latch.
- AC-P3-4: Reset appears only for an overridden builtin; firing re-seeds + clears dirty.
- AC-P3-5: Tools grid shows the 8 tools, live "N of M"; no `cyboflow_*` tool listed.
- AC-P3-6: no 3-model picker (model only as Stats); no `{{var}}` chips; no retry/loopback block; **a required description field is present**.
- AC-P3-7: closing with unsaved changes prompts confirm; Escape/overlay honor the dirty guard.

### Verification gate
`pnpm --filter frontend test`. `pnpm typecheck` (pure tRPC inference).

---

## P4 — Template-create flow + cross-project Run routing

**Goal:** "New workflow" → template gallery → seeded blueprint editor; "Run" → wizard locked to the card's project by workflow ID.

### Files created
- `frontend/src/components/workflows/GalleryNew.tsx` — `Modal size="lg"`: "From template" (one card per **deduped-by-name** existing workflow, each a `<PhaseRibbon thin />` preview, `onSelect(def, permissionMode, name)`) + "Blank canvas" (`onSelect(undefined)`). Maps the store's already-fetched `workflows[]` (no extra fetch).

### Files modified
- `frontend/src/components/cyboflow/WorkflowEditorModal.tsx` — add `initialDefinition?: WorkflowDefinition`, `initialPermissionMode?: PermissionMode`, `initialName?: string` props (corrects HIGH-14, MEDIUM-35). Change `loadCreate()` (≈:143–151) to `setSourcePermissionMode(initialPermissionMode ?? 'default'); seed(initialDefinition ?? SKELETON_DEFINITION, initialName ? initialName+'-copy' : '')`. Add the three props to the seed `useEffect` dep array (≈:163). Edit mode unaffected (the row's persisted definition wins). (P0 having re-pointed `SKELETON_DEFINITION`/builtin defs to canonical keys means a templated def never seeds a stale `executor` label.)
- `frontend/src/components/workflows/WorkflowsView.tsx` — wire card actions:
  - **Edit** → `<WorkflowEditorModal mode="edit" workflowId={entry.row.id} projectId={entry.row.project_id} onSaved={() => { close; refresh(); }} />`.
  - **Duplicate** → `workflows.createCustom.mutate({projectId: entry.row.project_id, name: '<name>-copy', definition: entry.definition, permissionMode: entry.row.permission_mode})` with a sync in-flight latch; on `CONFLICT` retry `-copy-2` once; `refresh()`.
  - **Run** → `useNavigationStore.getState().goToWizard({ lockProjectId: entry.row.project_id, preselectWorkflowId: entry.row.id })` (C10/HIGH-16 — closes Workflows pane via I10, wizard opens locked on Configure with the flow preselected by ROW ID; seed idea/tasks chosen in the wizard via existing pickers, HIGH-15).
  - **New workflow** → open `GalleryNew`; template select → `WorkflowEditorModal mode="create" initialDefinition={def} initialPermissionMode={pm} initialName={name}`; blank → `mode="create"` (no `initialDefinition`).
  - **New agent / Agent Edit** → open P3 `AgentEditorModal`.
- `frontend/src/components/SessionStartWizard.tsx` — preselect by ROW ID: `metas.find((m) => m.id === preselectWorkflowId)` (corrects HIGH-16); keep `preselectWorkflowName` only for the existing Insights compound CTA.

### Acceptance criteria
- AC-P4-1: "From template / planner" opens the editor pre-seeded with the planner graph (canonical agent keys), `sourcePermissionMode` = the source's mode, the `FlowNameDialog` default populated as `planner-copy`; "Save as new flow" → custom row after refresh.
- AC-P4-2: "Blank canvas" → 1-phase/1-step skeleton (unchanged); `initialDefinition` ignored in edit mode (regression guard).
- AC-P4-3: Duplicate of `planner` → `planner-copy` in the card's project after refresh; double-click does not double-create.
- AC-P4-4: Run on a planner card opens the wizard locked to that project, on Configure, **planner preselected by row id** (not name — no `sprint` fallback), idea-picker reachable via the CTA.

### Verification gate
`pnpm test:unit` (`WorkflowEditorModal` create-seed + permission-mode + name regression; wizard preselect-by-id). `pnpm typecheck`. Live smoke via `pnpm dev` + Peekaboo for template→editor→save and Run→wizard (E2E suite non-functional per CLAUDE.md).

---

## 4. Canonical agent catalogue

| agentKey | display name | role | tools (frontmatter) | runtime `.md` | workflows/steps that reference it |
|---|---|---|---|---|---|
| `context` | Context | planner | Read, Grep, Glob | `planner/agents/context.md` | planner · step `context` (was `idea-extractor`) — **bound** |
| `research` | Research | planner | Read, Grep, Glob, WebSearch, WebFetch | `planner/agents/research.md` | planner · step `research` (was `researcher`) — **bound** |
| `epics` | Epics | planner | Read, Grep, Glob | `planner/agents/epics.md` | planner · step `epics` (was `task-refiner`, step-disambiguated) — **bound** |
| `tasks` | Tasks | planner | Read, Grep, Glob | `planner/agents/tasks.md` | planner · step `tasks` (was `task-refiner`, step-disambiguated) — **bound** |
| `dependency-analyzer` | Dependency Analyzer | sprint | Read, Grep, Glob | `sprint/agents/dependency-analyzer.md` | sprint · step `analyze-dependencies` — **bound** |
| `implement` | Implement | sprint | Read, Edit, Write, Bash, Grep, Glob | `sprint/agents/implement.md` | sprint · step `execute-tasks` (was `executor`) — **bound** |
| `code-review` | Code Review | sprint | Read, Grep, Glob | `sprint/agents/code-review.md` | sprint prose dispatch (no step.agent) — **step-unbound, dispatched by sprint** |
| `write-tests` | Write Tests | sprint | Read, Edit, Write, Bash, Grep, Glob | `sprint/agents/write-tests.md` | sprint prose dispatch — **step-unbound, dispatched by sprint** |
| `task-verify` | Task Verify | sprint | Read, Bash, Grep, Glob | `sprint/agents/task-verify.md` | sprint prose dispatch (inside `execute-tasks`) — **step-unbound, dispatched by sprint** |
| `sprint-verify` | Sprint Verify | sprint | Read, Bash, Grep, Glob | `sprint/agents/sprint-verify.md` | sprint · step `sprint-verify` (was `verifier`) — **bound** |
| `visual-verify` | Visual Verify | sprint | Read, Bash, Grep, Glob | `sprint/agents/visual-verify.md` | sprint prose dispatch — **step-unbound, dispatched by sprint** |
| `sprint-review` | Sprint Review | sprint | Read, Grep, Glob | `sprint/agents/sprint-review.md` | sprint · step `sprint-review` (was `code-reviewer`) — **bound** |
| `compounder` | Compounder | compound | Read, Grep, Glob, Bash | `compound/agents/compounder.md` | compound · steps mining/tagging (3×) — **bound** |

> Exact per-agent `tools` lists are read from each `.md` frontmatter at boot by `loadBuiltInAgents()` (the table above reflects the bundled defaults; the catalogue is the source of truth, not this table). `role` is inferred from the owning workflow dir. `human` is intentionally absent (gate, not agent). Bound = a `step.agent` resolves to it (usage ≥ 1, 9 keys). Step-unbound but prose-dispatched (4 keys) = editable, fully effective at runtime, shown as "Dispatched by …" rather than "0 workflows."

## 5. Honest limitations & out-of-scope

1. **Per-agent token = estimate only** (`ceil(len/4)`), per-agent cost = `null` (omitted). `run_usage` is run-scoped (no per-agent attribution); never wired.
2. **Agents are model-agnostic** — inherit the run model; no per-agent model field/picker.
3. **Run requires a concrete project** — routes into the wizard (by workflow row id) scoped to the card's project; seed idea/tasks are chosen in the wizard, not pre-seeded from the gallery.
4. **Custom agents are write-only at runtime in v1** — written to the worktree but not auto-dispatched by built-in prose (available via `@`-mention). Auto-wiring custom agents into flows is a documented follow-up.
5. **Back-compat for old `task-refiner` snapshots is best-effort** — resolved correctly via step id when a snapshot is present; a bare label out of step context is lossy (display-only, documented).
6. **No agent-override audit log** — overrides are project config; no `entity_events` row (the CHECK constraint forbids it and a table rebuild is out of scope). A dedicated audit table is a future option.
7. **No `enabled`/disable toggle** in v1 — `reset` (delete row → bundled default) is the disable path.

## 6. Risks register

| ID | Sev | Risk | Mitigation |
|---|---|---|---|
| R1 | HIGH | Alias-map drift: a future builtin def adds a `step.agent` label that falls through to identity. | `LEGACY_BY_LABEL` sources are tested as real-only (AC-P0-3); `CANONICAL_AGENT_KEYS` is asserted deep-equal to the boot catalogue keys (single source, C9); step-aware resolver handles dual-binding. |
| R2 | HIGH | Custom/template workflows write zero agent files at spawn (`workflow_path NULL`). | Overlay is the FULL writer (I8): writes the entire effective set regardless of `workflow_path`; AC-P1-6 exercises a custom-workflow run on both substrates. |
| R3 | HIGH | `entity_events` CHECK violation aborts every override write. | Chokepoint does NOT touch `entity_events` (I3); AC-P1-9 asserts count unchanged. |
| R4 | HIGH | Step-unbound prose agents (`code-review`/`write-tests`/`task-verify`/`visual-verify`) show misleading "0 workflows." | `dispatchedBy` prose pass + inspector "Bound to N / Dispatched by …" (C7 case 2, AC-P1-3/AC-P3-1). |
| R5 | HIGH | Nav double-pane regression if any of the 11 `set(...)` sites misses `workflowsOpen:false`. | I10 enumerates all 11; AC-P2-1 tests both directions per site. |
| R6 | HIGH | Run launches the wrong flow via `preselectWorkflowName` name-collision → silent `sprint` fallback. | Preselect by ROW ID (`preselectWorkflowId`, C10); AC-P4-4. |
| R7 | HIGH | User-authored `description` carrying `cyboflow_*` slips past prompt-only validation. | Validate `/cyboflow_/` over the full rendered markdown (I1); AC-P1-5/AC-P1-8. |
| R8 | MED | Overlay writes cross-workflow override/custom files into every worktree. | Accepted + documented: teardown's `remove()` strips all `cyboflow-*.md`, no leak; the FULL-set semantics (I8) make this intentional (a custom flow needs all referenced builtins). |
| R9 | MED | Schema parity falsely assumed automatic. | Explicit `entitySchemaParity` `AgentOverrideRow` case added (HIGH-21); gate cites the correct test. |
| R10 | MED | Unbounded cross-project query fan-out. | One `runs.list` per project (grouped client-side), bounded `agents.list`/`workflows.list` per project (MEDIUM-22); AC-P2-5 all-projects case. |
| R11 | MED | Deleting a custom agent referenced by a step leaves a dangling `subagent_type`. | `deleteCustom` referential-integrity guard → `CONFLICT` with referencing names (MEDIUM-40); AC-P1-4. |
| R12 | MED | `ROLE_COLOR` maps to non-existent `--color-phase-planner/-sprint`. | Explicit map to existing vars (plan/execute/compound); unit-tested (MEDIUM-39). |
| R13 | MED | Overlay drift across the two managers if hand-mirrored. | Installed once in the shared `installWorkflowBundle` seam (I7); AC-P1-6 both substrates. |
| R14 | LOW | Frontmatter field-order mismatch breaks reused contract regex. | `renderAgentMarkdown` pins `name→description→tools` (I9); AC-P1-7. |
| R15 | LOW | Magic `13` drifts across three sites. | `CANONICAL_AGENT_KEYS` asserted deep-equal to boot catalogue keys (C9); contract test owns per-workflow ordered lists. |
| R16 | LOW | AREA-C ↔ AREA-B coupling. | `AgentGalleryEntry` view-model isolates field renames; Agents section feature-gates so the Workflows grid ships if P1/P3 slip. |

## 7. Open questions for the user

None. All previously open items (override table shape, agent identity, alias targets, the entity-events audit decision, custom-agent runtime behavior, Run routing, and the `enabled` toggle) are resolved by the settled decisions and the verified findings above.

### Key cited paths
`shared/types/workflows.ts:296–472` (step.agent; `task-refiner` at :330 epics + :338 tasks), `main/src/orchestrator/workflows/{planner,sprint,compound}/agents/*.md` (13 SOURCE files), `main/src/database/migrations/` (next=028; 027 highest), `main/src/database/migrations/015_entity_model_rebuild.sql:147` (entity_events CHECK — no `agent_override`), `main/src/orchestrator/workflowRegistry.ts:372` (createCustom `workflow_path NULL`), `main/src/orchestrator/workflows/workflowBundle.ts` (resolveWorkflowBundle, EMPTY_BUNDLE on null), `main/src/services/panels/claude/workflowBundle{Install,Writer}.ts` (shared seam + writer), `main/src/services/panels/claude/{claudeCodeManager,interactiveClaudeManager}.ts` (both call the seam), `main/src/orchestrator/trpc/router.ts` (mount `agents` first), `main/src/orchestrator/trpc/context.ts` (dep pattern), `main/src/orchestrator/{taskListing.ts:250,taskChangeRouter.ts:1435}` (byte-identical resolveAgentLabel), `main/src/orchestrator/mcpQueryHandler.ts` (`agent:` actor), `main/src/database/__tests__/entitySchemaParity.test.ts` (row↔column parity), `main/src/orchestrator/workflows/__tests__/workflowBundle.builtins.test.ts` (SOURCE contract — necessary, not sufficient), `frontend/src/components/cyboflow/{workflowEditorOptions.ts,WorkflowStepCard.tsx:101,WorkflowEditorModal.tsx}`, `frontend/src/stores/{navigationStore.ts,insightsStore.ts}`, `frontend/src/{App.tsx,components/Sidebar.tsx}`, `frontend/src/components/landing/FlowProgress.tsx:49` (flex-1 equal-width).
