# Global Agent — Detailed Implementation Plan (Stages 0–1)

Status: PROPOSED (Codex-adversarial-reviewed 2026-07-17: 8 findings, all incorporated below;
pending human approval). Owner: Krishna.
Design reference: `design_handoff_review_queue_agent` handoff bundle (Downloads, 2026-07-06) —
`README.md` + `Action Cards.dc.html` (card anatomy source of truth) + `Review Queue Agent.dc.html`
(placement 2a). The packet's SoloFlow-era references (`/soloflow:*`, `dashboard.jsx`,
`IDEA-019.md`) are stale; concept mapping to the live architecture is defined here.

## 1. Product intent (locked with Krishna)

A standing "cyboflow agent" chat in a new **right rail on the landing-family views** (not the
session view, which keeps `RunRightRail`). It targets the three highest-UI-friction jobs:

1. **Sessions overview** — "where is everything?": one digest of all running/blocked/idle
   sessions and runs across projects, with deep links.
2. **Backlog reprioritization + kickoff** — propose priority/stage changes across the backlog,
   then kick off runs (sprint/planner/ship) seeded with the top items.
3. **Workflow modification** — "change workflow X to do [y]": agent drafts a definition/variant
   edit, user reviews a config-diff card, confirm applies it.

Interaction contract (**the promptable boundary**):
- The agent **reads and suggests proactively** but **never executes**. Every state change is a
  **proposal card**; only the user's Confirm click executes, server-side, through existing
  chokepoints, stamped `actor: 'user'` (matching `resolveReviewItemHandler.ts:45-46`'s
  documented convention: a human confirming is the human's decision).
- Structural, not promptual: the agent's toolset contains **no mutating tools** — its only
  write-shaped tool is `cyboflow_propose_action`, which records a proposal row. It cannot
  reach `TaskChangeRouter`, `ReviewItemRouter`, `WorkflowRegistry`, or run control. The
  isolation-mode spawn (§2.1a) makes this hold against inherited config, not just our own.

Deliberately deferred: single-item review-queue decisions (Stage 2), bulk approve (Stage 2),
session-scoped agent tab (Stage 3), event-triggered standing monitoring (Stage 4),
experiment launching (no chokepoint/MCP surface yet), review-queue reordering (no persisted
order substrate on `review_items`).

## 2. Architecture (verified against the codebase, 2026-07-17)

### 2.1 Hosting: a real SDK conversation, no run/session/worktree rows

The agent is a warm persistent SDK conversation spawned through the existing
`ClaudeCodeManager.spawnCliProcess` with **synthetic identity** `panelId === sessionId ===
'agent:<threadId>'` and a **neutral cwd** (`~/.cyboflow/agent-home/<threadId>/`, or the
per-kind dev data dir equivalent). Verified safe (seam pass):

- `ClaudeSpawnOptions` requires only `panelId, sessionId, worktreePath, prompt`
  (`claudeCodeManager.ts:494-562`); every DB lookup for an unknown sessionId optional-chains
  and degrades (`getDbSession` returns `undefined`, never throws).
- `resolveGateRunId` collapses a DB-less sessionId to the flow-step branch → `gateRunId =
  panelId` (`claudeCodeManager.ts:1066-1072`) — no throw, no sentinel-run requirement.
- Warm-session machinery works keyed on `spawnKey` (defaults to `panelId`; omit `spawnKey`
  to stay warm-eligible — a caller-supplied different value is treated as a fan-out lane and
  forced single-shot, `claudeCodeManager.ts:1024`). **Codex finding (medium), incorporated:**
  spawn-key identity alone is NOT sufficient for warm reuse — `evaluateWarmReuse`
  (`claudeCodeManager.ts:1908-1941`) requires `resumeSessionId` matching the captured warm
  id (the SessionManager-panel path is unavailable for a synthetic panel). Therefore
  `AgentThreadService` threads the persisted/captured `claude_session_id` as
  `resumeSessionId` on **every** continuation turn, not just post-restart; acceptance tests
  cover warm-continuation and stale/rejected-resume recovery (fall back to a fresh
  conversation and persist the new id).

### 2.1a Isolation mode (Codex finding — CRITICAL, incorporated)

`buildSdkOptions` today sets `settingSources: ['user','project']`, which re-adds the user's
global MCP servers from `~/.claude.json` / project `.mcp.json`, inherits plugins, unions
permission rules with global settings (`permissionRules.ts:257-286`), and — for a session
with no DB row — inherits the **global default permission mode, including `dontAsk`**
(`claudeCodeManager.ts:2301-2347, 2442-2453, 2672-2683, 3549-3558`). Without intervention a
prompt-injected agent could invoke an inherited mutating MCP tool (or at minimum mint
approval traffic). The plan's original `tools: []` + scoped-MCP design did not close this.

New explicit spawn contract, `ClaudeSpawnOptions.isolation: 'agent'`, which forces:
- `settingSources: []` — no user/project settings, no inherited permission `allow` rules;
- `strictMcpConfig: true` + an **exclusive** `mcpServers` map containing only the scoped
  cyboflow entry (no `getBaseProjectMcpServers` merge, no plugin-provided servers);
- plugin inheritance disabled (empty/exclusive plugin map);
- `tools: []` (no built-ins) and a **pinned fail-closed permission policy**: explicit
  permission mode, PreToolUse hook configured deny-by-default for anything outside the
  agent tool family (defense-in-depth — with the above, nothing else should exist to call).
- The neutral-cwd `.claude/settings.local.json` allowlist is retained only as belt-and-braces.

**Acceptance (S0.2): an integration test with hostile fixtures** — a user-level
`~/.claude.json` MCP server, a project `.mcp.json`, a plugin, and a permissive global
settings file — proving the agent spawn's resolved SDK options contain none of them and
that only the approved global tools are callable.

### 2.2 Transcript + proposals: new tables, not a sentinel run (DECIDED)

Seam verification surfaced a fork: reuse `raw_events` via a minted sentinel `workflow_runs`
row (the `__quick__`/`chat_run_id` precedent) vs. new tables. **Decision: new tables.**
Rationale:

- `workflow_runs.project_id` is NOT NULL — a truly cross-project global agent has no honest
  project to bind to; a synthetic "global project" row would leak into project lists.
- A permanently non-terminal sentinel run risks leaking into every run-listing surface
  (`activeRunsStore`, ready-to-review classification, insights) and each would need a
  `__global_agent__` name filter — a recurring tax on every future run query.
- The projection layer (`MessageProjection`/`TypedEventNarrowing`) is id/table-agnostic
  (proven by the `session_outputs`-based `projectStoredOutputs` reuse,
  `main/src/ipc/session.ts:114-163`), so chat-pipeline reuse survives intact.

**Persistence writer (Codex finding — high, incorporated):** parameterizing `RawEventsSink`'s
table name is NOT viable — its prepared SQL hard-codes the `(run_id, event_type,
payload_json, created_at)` column set and always binds its attached run id
(`rawEventsSink.ts:45-53, 63-75`), which for us is the `agent:<threadId>` string while the
FK targets bare `agent_threads.id`; both failure shapes are swallowed fail-soft. Instead:
a dedicated **`AgentThreadEventsSink`** (small class mirroring `RawEventsSink`'s shape)
owning the `agent:<threadId>` → `threadId` mapping and the `agent_thread_events` insert,
and it is the **single durable writer** — the spawn seam gains an option to *suppress* the
built-in `RawEventsSink` attach and accept an injected sink (S0.2), and `AgentThreadService`
does NOT add a second insert path (S0.3 bridges only the live-tail publish). Integration
test: one full fake-SDK turn → zero FK/column warnings, exactly one row per event.

Schema (migration number allocated at implementation time — 070 is already contested by two
unpushed branches; renumber on rebase):

```sql
CREATE TABLE agent_threads (
  id TEXT PRIMARY KEY,                    -- uuid; spawn identity is 'agent:<id>'
  scope TEXT NOT NULL DEFAULT 'global',   -- future: 'run:<runId>' for Stage 3
  model TEXT,                             -- NULL = ConfigManager default
  claude_session_id TEXT,                 -- persisted resume target
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE agent_thread_events (        -- shape mirrors raw_events, thread-keyed
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_agent_thread_events_thread ON agent_thread_events(thread_id, id);
CREATE TABLE agent_proposals (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN
    ('launch-run','reprioritize-backlog','edit-workflow','open-session')),
  payload_json TEXT NOT NULL,             -- typed per kind (shared/types/agentThread.ts)
  preconditions_json TEXT,                -- per-kind CAS material (spec hash, expectedVersions)
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
    ('proposed','executing','executed','failed','dismissed','superseded')),
  result_json TEXT,                       -- executor outcome / per-item partial results
  idempotency_key TEXT,                   -- stamped at CAS time; side effects carry it
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME
);
```

Live tail is storage-independent: `cyboflowPublisher.publish(threadId, envelope)` +
renderer `subscribeToStreamEvents({runId: threadId})` do **zero** DB validation of the id —
reuse unmodified.

### 2.3 Projection + chat UI reuse

- New `agentThreadUnifiedMessagesListing.ts`: near-literal copy of
  `runUnifiedMessagesListing.ts:39-134` with the SELECT retargeted at
  `agent_thread_events`; imports `TypedEventNarrowing` / `MessageProjection` /
  `agentStreamEventToClaudeStreamEvent` / `isAgentStreamEvent` unchanged.
- Frontend renders through the **existing `UnifiedChatView`** (built for a third host) with a
  new `ChatMode` variant `'agent'` (closed union today: `'quick' | 'flow'`,
  `useChatVisibility.ts:25`), `messages` from a `useUnifiedAgentThreadMessages(threadId)` hook
  mirroring `useUnifiedRunMessages` (debounced refetch on live-tail signal), and a
  thread-specific `bottomSlot` (composer + chips). `folderLabel/branchName/contextUsage`
  pass `null` (no worktree).

### 2.4 Toolset: global MCP family, hard-restricted

The SDK spawns the agent's own `cyboflowMcpServer.js` subprocess (the `composeMcpServers`
pattern — there is no way to point `mcpServers` at an already-running subprocess without a
custom Transport). Changes:

- **Scope gate in `cyboflowMcpServer.ts`**: module-scope branch on a new
  `CYBOFLOW_MCP_SCOPE=global-agent` env (set only by the agent spawn's MCP entry). In this
  mode the server advertises **only** the global family below; the 31 run-scoped tools are
  not listed and their call cases reject. Conversely the global family is absent in run scope.
- **Handler side (`mcpQueryHandler.ts`)**: accept the `agent:<threadId>` sentinel via a new
  `resolveGlobalAgentContext` (sibling of `resolveTaskRunContext:1285`); run-scoped resolvers
  continue to reject it. New `McpQueryMessage` variants + handlers + `writeResponse` cases
  following the 4-layer pattern (decl → validation → `sendQuery` type → handler case).
- **Built-in tools**: hard-restrict via new `tools?: string[]` plumbing on
  `ClaudeSpawnOptions` → `sdkOptions.tools` (SDK supports it; cyboflow never wired it —
  verified no `allowedTools`/`tools` reference exists in `claudeCodeManager.ts`). The agent
  gets NO built-in tools in Stage 1 (`tools: []`) — reads go through the MCP family so scope
  stays enforceable server-side. This restricts *our* surface; §2.1a isolation restricts the
  *inherited* one — both are required.

Global tool family (all new handlers; cross-project SQL is genuinely new — verified no
existing cross-project backlog/queue/session query exists):

| Tool | Shape |
|---|---|
| `cyboflow_overview` | Read. Sessions + runs across all projects: status, current step, substrate, blocked/pending-gate info, quick-session board state, age. |
| `cyboflow_backlog` | Read. Ideas/epics/tasks across projects (or one project via param) with priority, stage, dependencies. Wraps `selectProjectBacklog` per project. |
| `cyboflow_entity` | Read. One entity's full body by ref + explicit projectId. |
| `cyboflow_queue` | Read. Pending review items + pending approvals + pending questions across projects (aggregation mirroring `landingStore`'s server-side sources). |
| `cyboflow_workflows` / `cyboflow_workflow` | Read. List (explicit projectId or global) / get one effective definition. `projectId` is dead weight for get; needed only for list/create. The get response includes the **current spec hash** used for proposal preconditions (§2.5). |
| `cyboflow_propose_action` | Write-shaped. `{kind, title, summary, payload, projectId?}` → captures per-kind preconditions (current spec hash / task versions), inserts `agent_proposals` row + emits thread/proposal events. Returns the proposal id. NEVER executes. |

### 2.5 Proposal execution (Confirm path)

New pure handler `main/src/orchestrator/agentThread/proposalExecutor.ts` modeled on
`resolveReviewItemHandler.ts` (structural deps interface, discriminated
`{ok:true}|{ok:false,reason}` result, standalone-typecheck safe), wired at boot via
`setProposalExecutorDeps({...})` in `main/src/index.ts` (the `setStartRunDeps` /
`setExperimentsDeps` late-bound-holder pattern).

**Execution state machine (Codex finding — high, incorporated).** Confirmation is an
idempotent, crash-recoverable sequence, not execute-then-persist:
1. **CAS claim**: guarded `UPDATE agent_proposals SET status='executing',
   idempotency_key=? WHERE id=? AND status='proposed'` — 0 rows updated ⇒ another caller
   won (double-click, concurrent confirm, retry); reject with `{ok:false, reason:'claimed'}`.
2. **Precondition check** (per kind, below) — failure ⇒ `superseded` with a refreshed-diff
   loopback turn, never a blind overwrite.
3. **Side effects**, carrying the idempotency key where the target supports it.
4. **Terminal transition** to `executed`/`failed` with `result_json`.
5. **Crash recovery**: at boot, `executing` rows are reconciled — verify observable side
   effects (run exists? priority applied? spec hash now matches proposed?) and transition to
   `executed` or `failed:'crashed-mid-execution'` with what was verified; never silently
   re-run.

Per kind:

- **`launch-run`** — `createQuickSessionCore(deps, {projectId, ...})` to mint the fresh host
  session, then `RunLauncher.launch(workflowId, project.path, substrate, ..., session.id,
  ..., seeds...)`. Seeds per workflow: `taskIds` (sprint), `ideaId`/`ideaIds` (planner/ship),
  `findingIds` (compound). `sessionId` is a hard `RunLauncher` requirement — no session-less
  path exists. **Launch saga (Codex finding — high, incorporated):** the executor tracks
  created resource ids and compensates on every post-session failure — cancel any created
  flow run, dismiss the host session through the existing safe cleanup path (the A/B
  `experiments.ts:663-683, 709-749` rollback ladder is the model to follow, not just its
  panel bootstrap), remove the worktree, and persist compensation failures into
  `result_json` for boot-time reconciliation. Failure at each boundary is tested. Panel
  bootstrap for the surviving session follows the A/B-winner precedent so it is inspectable.
- **`reprioritize-backlog`** — N sequential
  `TaskChangeRouter.getInstance().applyChange(projectId, {actor:'user', taskId,
  fields:{priority}} | {actor:'user', taskId, stageId})` calls with `expectedVersion` from
  `preconditions_json`. **No atomic batch exists** (verified) — the executor collects
  per-item results and surfaces partial failure explicitly in `result_json`; the card
  renders per-row ✓/✕.
- **`edit-workflow`** — **CAS against a spec hash (Codex finding — high, incorporated):**
  `WorkflowRegistry.getById` exposes no version and `updateSpec` is an unconditional UPDATE,
  so the proposal stores a canonical hash of the definition it was drafted against
  (captured by `cyboflow_propose_action` at propose time). Confirm runs, inside one
  transaction: re-read `spec_json` → canonical-hash compare → mismatch ⇒ `superseded` +
  refreshed-diff loopback turn; match ⇒ `workflowDefinitionSchema.safeParse(definition)` →
  `workflowRegistry.updateSpec(workflowId, parsed.data)` (or variant ops with the analogous
  expected-revision compare). Validation failure loops back into the thread as a turn so the
  agent revises — not a dead end.
- **`open-session`** — no executor: pure renderer navigation with a **discriminated payload
  (Codex finding — medium, incorporated)**: `{target: 'run', runId}` →
  `useCyboflowStore.setActiveRun`; `{target: 'quick-session', sessionId, runId?}` →
  `setActiveQuickSession(sessionId, runId?)` — routing an idle quick session through
  `setActiveRun` is a documented stuck-on-"Loading workflow…" trap
  (`TypeGroupedQueue.tsx:102-112`). Tests cover active flow, active quick, resting quick.

All executed with `actor: 'user'`.

### 2.6 tRPC + renderer wiring (verified)

- New `main/src/orchestrator/trpc/routers/agentThread.ts` (pattern: `questions.ts`):
  `getThread`, `listMessages`, `sendMessage`, `triggerDigest`, `listProposals`,
  `confirmProposal`, `dismissProposal`; subscriptions `onThreadEvent` (throttled like
  `onStreamEvent`) + `onProposalUpdate` via the `eventToAsyncIterable` async-generator idiom.
  Register in `router.ts`; extend `context.ts` with a narrow `AgentThreadServiceLike` dep;
  wire in `index.ts` next to the other `createContext` deps. Renderer client needs zero
  changes (AppRouter type flows through).
- Rail mounts in **`App.tsx`** as a flex sibling of the view-switch div (NOT inside
  `LandingHome`) gated `view !== 'session' && view !== 'wizard'` — the `CyboflowRoot` two-column
  precedent; this covers all landing-family surfaces with one mount. Width/collapse lifted to
  App.tsx, localStorage keys `cyboflow.agentRail.width` / `cyboflow.agentRail.collapsed`
  (current dot-namespace convention; brand-new keys, no `migrateLocalStorageKey` needed).
- New `frontend/src/stores/agentThreadStore.ts` — idempotent `init()` called once from
  App.tsx alongside the other five store inits; subscribes to the two subscriptions; reads
  `useLandingStore`/`useActiveRunsStore` selectors directly for card context (no duplicate
  fetching).

## 3. Task decomposition

Sizes: S ≈ ≤1 day, M ≈ 1–2 days, L ≈ 2–4 days. AC gate for every task: `pnpm typecheck`,
`pnpm lint`, `pnpm test:unit`. Tasks touching `main/src/services/panels/claude/` MUST also run
`pnpm test:integration` (Tier-3 mocked-SDK itest suite — blocking CI). No `any` anywhere.

### Stage 0 — backend foundations

**S0.1 (M) Schema + thread store.** Migration (number allocated at rebase time) creating
`agent_threads` / `agent_thread_events` / `agent_proposals` (incl. `executing` status,
`preconditions_json`, `idempotency_key`); `AgentThreadDbStore` class (CRUD + event append +
**CAS status transitions** as guarded UPDATEs); shared types in `shared/types/agentThread.ts`
(thread, event envelope, `AgentProposalKind` payload unions, discriminated navigation
payload, status enums). Unit tests: store round-trips, CAS claim semantics (0-rows loser),
status-transition guards, CASCADE behavior.

**S0.2 (L) Spawn-seam extensions: isolation mode + tools + sink injection**
(`claudeCodeManager.ts` — itest gate applies).
(a) `isolation: 'agent'` spawn contract per §2.1a (settingSources `[]`, strictMcpConfig,
exclusive mcpServers/plugins, pinned fail-closed permission policy).
(b) `tools?: string[]` → `sdkOptions.tools`, included in `computeOptionsFingerprint` so a
toolset change busts the warm process.
(c) Sink injection: option to suppress the built-in `RawEventsSink` attach and accept an
injected events sink for this spawn (single-writer contract).
(d) MCP entry variant: `composeMcpServers` override adding `CYBOFLOW_MCP_SCOPE=global-agent`.
Acceptance: hostile-fixture itest per §2.1a proving no inherited MCP/plugins/rules; fingerprint
bust on tools change; injected-sink routing with zero FK/column warnings.

**S0.3 (M) AgentThreadService** (`main/src/orchestrator/agentThread/agentThreadService.ts`).
Mints/loads the global thread; prepares the neutral home dir (belt-and-braces
`.claude/settings.local.json` allowlist); `sendMessage(threadId, text)` → spawn/warm-push via
`ClaudeCodeManager` with synthetic identity + isolation mode + `AgentThreadEventsSink`
(the single durable writer, owning the `agent:<threadId>`→`threadId` mapping);
**threads persisted `claude_session_id` as `resumeSessionId` on every continuation turn**
(warm-reuse requirement), with stale-resume recovery (fresh conversation + persist new id);
bridges typed events → `cyboflowPublisher.publish(threadId, envelope)` live-tail only (no
second insert path); `triggerDigest` (synthetic prompt, server-throttled ≥10 min). Unit tests
with the fake-SDK harness: warm continuation, resume recovery, single-writer persistence.

**S0.4 (L) MCP global scope + tool family.** `cyboflowMcpServer.ts` scope gate
(`CYBOFLOW_MCP_SCOPE`); `mcpQueryHandler.ts` `resolveGlobalAgentContext` + new message
variants/handlers for `cyboflow_overview` / `cyboflow_backlog` / `cyboflow_entity` /
`cyboflow_queue` / `cyboflow_workflows` / `cyboflow_workflow` / `cyboflow_propose_action`
(the last capturing per-kind preconditions: current workflow spec hash, task
`expectedVersion`s); new cross-project SQL. Propose handler inserts via `AgentThreadDbStore`
and emits the proposal event. Tests: handler unit tests per tool, scope-gate tests both
directions, precondition capture.

**S0.5 (L) Proposal executor.** `proposalExecutor.ts` pure handler + `setProposalExecutorDeps`
boot wiring implementing the §2.5 state machine: CAS claim, per-kind precondition checks
(workflow spec-hash CAS in-transaction; task `expectedVersion`s), side effects (generalized
launch helper = `createQuickSessionCore` + `RunLauncher.launch` **with the compensation
saga**; sequential reprioritize with per-item partial results; workflow safeParse→CAS→apply
with validation loopback), terminal transitions, and **boot-time `executing`-row
reconciliation**. Unit tests: each kind against fakes; double-confirm race (loser rejected);
crash-recovery reconciliation; saga compensation at each failure boundary; stale/superseded
paths; `actor:'user'` stamped on every chokepoint call.

**S0.6 (M) tRPC router + events.** `agentThread.ts` router (procedures + 2 subscriptions),
`agentThreadUnifiedMessagesListing.ts` projection, context dep + `index.ts` wiring, emitter
bridge. `confirmProposal` → executor (which owns all status transitions) → `onProposalUpdate`
emit; executor validation/supersede loopbacks inject thread turns. Router unit tests.

**Dependency DAG (corrected per Codex finding — medium):**
S0.1 → {S0.2, S0.3, S0.4, S0.5}; S0.2 → S0.3; **S0.6 depends on S0.3 + S0.4 + S0.5**
(it exposes the service, the propose flow, and the executor — it cannot land first).
Parallelizable pairs after S0.1: (S0.2→S0.3) ∥ S0.4 ∥ S0.5-interface-work; S0.5's executor
side-effect wiring needs S0.4's precondition capture shape agreed (shared types in S0.1).

### Stage 1 — rail UI + the three jobs

Stage 1 **integration** work depends on the complete Stage 0 backend (S0.6 + everything
under it). S1.1/S1.2 component work may start earlier **against mocked store data only**,
explicitly outside the shippable critical path.

**S1.1 (M) Rail shell.** `frontend/src/components/agentRail/AgentRail.tsx` mounted in
`App.tsx` per §2.6; resizable/collapsible (clone `RunRightRail` drag math — right-anchored
rails need delta-from-drag-start, not `clientX`); header per packet (glyph mark, "cyboflow
agent", "acts across all sessions", GLOBAL chip); Paper-theme token classes only (the
packet's hexes are the existing `colors.css` tokens; literal hex only with the
justifying-comment convention).

**S1.2 (M) Thread view + composer.** `agentThreadStore` (init pattern, subscriptions);
`useUnifiedAgentThreadMessages`; `ChatMode` `'agent'` variant + identity-strip branch;
`AgentComposer` (send mutation, model chip from thread row, italic placeholder); suggestion
chips (static Stage-1 set: `Where is everything?`, `Triage the backlog`, `Kick off top
tasks`, `Modify a workflow`) that send canned prompts. Auto-digest trigger on first
landing-view open per app launch (calls `triggerDigest`; server throttle is authoritative).

**S1.3 (L) Proposal cards.** `ProposalCard` renderer keyed by kind, per packet card anatomy
(dark head bar / needs-confirm / body / rust-primary + ghost buttons / resolved row states,
120ms border-color transitions only): launch card (workflow, seeds, project, model line),
reprioritize card (ranked rows with ↑/↓ deltas + reasoning + per-row ✓/✕ partial results),
workflow-edit card (summary + config-diff rows + validation-failure and superseded/refreshed
states), open-session card (read-only chrome, discriminated navigation per §2.5).
Confirm/dismiss → `confirmProposal`/`dismissProposal`; optimistic `executing` state
reconciled by `onProposalUpdate` (incl. the race-loser `claimed` rejection). Component tests
for state transitions.

**S1.4 (S) Agent prompt.** System-prompt authoring for the global agent (role, the promptable
contract — "you cannot execute; propose via cyboflow_propose_action and STOP; never claim an
action happened", tool-usage guidance, digest format, proposal-quality bar). Lives in
`main/src/orchestrator/agentThread/` beside the service (pattern: workflow prompt docs).

**S1.5 (M) Integration polish + live smoke.** End-to-end pass of the three jobs against
`pnpm dev`: digest accuracy vs. live board; reprioritize round-trip visible on the backlog
board; workflow edit visible in the editor (and a mid-flight external edit produces the
superseded card, not an overwrite); launch card starts a run whose session is inspectable,
and a forced launch failure compensates cleanly. Visual pass vs. packet. Dev-log
(`cyboflow-frontend-debug.log`/`backend`) review for silent errors (esp. sink warnings).

### Later stages (scoped elsewhere, unchanged from the approved shape)

Stage 2: single-item queue decisions + bulk approve (+ fix pre-existing
`decideRestOfRunHandler` bug that strands folded `review_items` rows `pending`).
Stage 3: session-scoped agent tab (5th `RunRightRail` tab; `scope:'run:<id>'` threads;
converge with monitor, don't duplicate). Stage 4: event-triggered wakeups, experiment
launching once a chokepoint exists.

## 4. Risks & mitigations

1. **Inherited-config trust-boundary escape** (Codex critical) — closed by §2.1a isolation
   mode + hostile-fixture itest asserting the resolved options and callable-tool surface.
2. **Proposal double-execution / crash ambiguity** (Codex high) — closed by the §2.5 CAS
   state machine, idempotency keys, and boot reconciliation; race/crash tests in S0.5.
3. **Silent transcript loss** (Codex high) — closed by the dedicated single-writer
   `AgentThreadEventsSink` + suppressed built-in sink + one-row-per-event itest.
4. **Stale workflow overwrite** (Codex high) — closed by spec-hash CAS inside the confirm
   transaction + superseded/refreshed-diff card state.
5. **Launch-failure resource leaks** (Codex high) — closed by the compensation saga modeled
   on the A/B experiments rollback ladder; per-boundary failure tests.
6. **Migration-number collision** — 070 already contested by ≥2 unpushed branches. Allocate
   at implementation; renumber on rebase; schema-parity tests updated with it.
7. **Trust-boundary regressions over time** — unit test asserting the global-agent MCP
   scope's advertised tool list contains only the approved family; fixture-level assertion
   that agent spawns carry isolation mode.
8. **Warm-session drift** — `tools` + isolation fields join `computeOptionsFingerprint`;
   `resumeSessionId` threaded every turn (§2.1); stale-resume recovery tested.
9. **Rail regressions across landing surfaces** — collapsed-by-default decision for narrow
   windows; testids for e2e smoke specs (follow `RunRightRail` conventions).
10. **ABI ping-pong during development** — after `pnpm dev`/e2e, `pnpm rebuild
    better-sqlite3` before host-Node vitest.

## 5. Open questions (non-blocking, decide during implementation)

- Digest auto-trigger policy: first-open-per-launch (planned) vs. also on queue-delta
  thresholds (Stage 4 territory — keep out of Stage 1).
- Model default for the thread: ConfigManager default vs. pinned cheaper model; the
  `agent_threads.model` column supports either; composer chip displays it (switch UI can be
  Stage 1.5 or 2).
- Whether `cyboflow_backlog`/`cyboflow_queue` return all projects by default or require an
  explicit project filter beyond N projects (token-budget guard for the digest prompt).

## 6. Adversarial review log

- 2026-07-17 Codex CLI (`adversarial-review`, working-tree scope): verdict needs-attention;
  8 findings (1 critical / 4 high / 3 medium) — inherited-config escape, confirm race,
  sink column/FK mismatch, workflow stale-write, launch resource leak, quick-session
  navigation trap, warm-reuse resumeSessionId requirement, dependency-DAG error. All 8
  accepted and incorporated (§2.1, §2.1a, §2.2, §2.5, §3 DAG, §4).
