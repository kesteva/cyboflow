# Cyboflow — System Design

This project started as a simple Claude code Plugin, however that approach quickly hit limitations becuase of the capability constraints of a plugin. 

The vision is an app that looks like this reference design found in '/protoflow-design' (this is a direction not a strict design file) 

After analyzing a range of build vs. fork appraoches (see /initial-research for reference) landed on the approach of forking stravu/crystal.

The initial goal is to get to a working MVP in two weeks. To do this, two product choices:
1. No workflow customization (agents or steps). That can come down the road
2. Human review queue *is* table-stakes for MVP. That is the main differentiator. 

There will be two main milestones in the MVP:
1. Orchestrator is up and running - goal: end of week 1
2. Human review queue is working - goal: end of week 2

The remaining doc is a guide put together by Claude desktop

---

## 1. Product Thesis

**The thing being built.** Cyboflow is a **self-contained** desktop app that orchestrates Claude Code as a multi-agent workflow runner. It ships **three native flows** — **Planner** (turn a raw idea into a reviewed backlog of epics + tasks), **Sprint** (execute the ready tasks), and **Compound** (mine merged runs for durable learnings, launched from the Insights view) — whose prompt bodies live in the app source; there is no runtime dependency on any external workflow-runner plugin. Users start a flow against a repo; the app spawns Claude Code in an isolated git worktree per run, parses the structured stream-json output, surfaces the work in a custom UI, writes the app's own DB-canonical backlog, and concentrates everything that needs human attention into a single review queue.

**The differentiator.** Everyone in this category is competing on agent autonomy, parallelism, or hand-off ergonomics. Cyboflow's bet is that the scarce resource is *human attention*, not agent time. The unified review queue — one pane aggregating tool-use approvals, agent findings, human-gate decisions, and manual tasks from every running flow — is the product. Everything else is the substrate that makes it possible.

> **Naming note (P0 SoloFlow rip-out).** This document predates the rebuild that brought the flows in-app. Historical references below to "five pre-set SoloFlow workflows" describe the original fork posture; the shipped app exposes three built-in flows (Planner, Sprint, Compound — `compound` was rebuilt natively from the preserved prose). The dropped `soloflow` / `prune` flows have their prose preserved under `docs/workflows-future/` for a future cyboflow-native rebuild. The `__quick__` sentinel remains an internal, picker-hidden lightweight path.

**The user, the wedge, and what's out of scope.** The v1 user is a solo developer running multiple parallel flows on their own repos. The wedge is workspace-scoped review concentration over a fully self-contained planner→sprint pipeline. Out of scope for v1: cloud agents, teams, multi-user, auth, custom DAG editing beyond the in-app step editor, agent customization, workflow versioning, anything that requires a backend service.

**The two-week MVP (historical milestone).** A signed, notarized macOS app that can: pick a built-in flow, run it in a git worktree against a real repo, stream Claude Code's structured output into a custom UI, surface tool-use approvals in a workspace-scoped review queue, and reliably pause-and-resume runs based on human approval decisions.

---

## 2. Stack Decision

**Electron + node-pty + xterm.js + React + TypeScript + Tailwind + Zustand.**

The stack is chosen for time-to-MVP given a TypeScript-fluent developer working primarily through Claude Code. Tauri was considered and rejected for v1 because Cyboflow's complexity lives in the UI and integration glue (where TypeScript dominates), not in systems-level code (where Rust would shine). The team-tier scaling path requires a backend service regardless of desktop stack, so deferring Rust does not foreclose long-term options.

**Specific dependencies:**
- `electron` (LTS, pinned via fork)
- `@homebridge/node-pty-prebuilt-multiarch` (not raw `node-pty`; ships pre-built binaries, fewer universal-binary build problems)
- `better-sqlite3` for persistence (synchronous, transactional, WAL mode)
- `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-webgl` for embedded terminal rendering when needed
- `react` + `react-dom` for UI
- `zustand` for state management (one slice per domain, no Redux)
- `electron-trpc` + `@trpc/server` + `@trpc/client` (v11) for typed RPC between renderer and orchestrator
- `superjson` as tRPC transformer for Date/BigInt fidelity
- `zod` for runtime validation at the stream-parsing boundary only
- `@modelcontextprotocol/sdk` for the cyboflow MCP server
- `p-queue` for per-run mutation serialization and concurrency limits
- `tailwindcss` for styling
- `vite` for renderer bundling
- `electron-builder` for packaging and signing

**Explicitly not using:** Bull/Redis (Crystal's `CLAUDE.md` mentions it; production code uses in-process `SimpleQueue` — do not wire up Redis), Drizzle/Prisma (hand-rolled SQL is faster for the MVP), Codex/OpenAI integration, auto-update for v1.

---

## 3. Foundation: Fork Crystal

**Source.** Fork `stravu/crystal` at HEAD (MIT-licensed, deprecated in favor of Nimbalyst but stable). The codebase implements six of Cyboflow's eight required primitives in production-tested form. Greenfield equivalent is estimated at roughly 2× calendar time with no architectural wins for the v1 differentiator.

**What the fork provides directly usable.**
- `AbstractCliManager` and `CliManagerFactory` for PTY-based Claude Code session management
- `SimpleQueue` for in-process concurrency limiting (`session-creation` cap 5, `session-input`/`session-continue` cap 10, 1 on Linux)
- `WorktreeManager` for `git worktree add -b ...` lifecycle with collision-safe naming and background cleanup
- `DatabaseService` with `better-sqlite3`, WAL mode, and a hand-rolled migration system
- `PermissionIpcServer` for Unix-socket-based permission bridging — the synchronous mechanism that pauses Claude on `--permission-prompt-tool` and resumes on socket reply
- `electron-builder` configuration for universal-binary signing, notarization, asar-unpack for native modules, and the `@electron/rebuild` postinstall hook
- Zombie-process detection on app boot, race-condition hardening with per-session mutexes, and platform-specific PTY concurrency tuning

**What changes from Crystal.** Branding (appId `com.cyboflow.app`, data dir `~/.cyboflow`, app icon, signing identity), the per-panel approval modal (replaced with the workspace queue view), Crystal's renderer-side `ClaudeMessageTransformer` (moved to main process and replaced with a typed stream parser), the AI-driven worktree naming step (replaced with deterministic `cyboflow/<workflow>/<runId8>`), and the "panel" abstraction (collapsed to "workflow run" — one agent per run, no multi-agent-per-session UI).

**What gets ripped out, and why.** The fork inherits a substantial codebase shaped for Crystal's product story, not Cyboflow's. Two principles guide the cut decisions: **delete things whose presence would mislead** (wrong product story, wrong implementation paths, wrong mental model); **hide things whose presence is harmless but adds noise** (working code that's out of scope for v1 but might come back in v2). Carrying hidden code costs a bit of extra LOC; carrying misleading code costs decisions made on wrong assumptions, which is much more expensive.

The specific cuts:

- **Codex/OpenAI integration — delete.** Crystal supports both Claude Code and OpenAI Codex as agent backends, with separate manager classes and UI surfaces. Cyboflow's thesis is built on Claude Code's stream-json output and Claude's permission-prompt-tool mechanism; the Codex paths are dead weight that complicate the codebase for no v1 benefit. Multi-provider support, if ever wanted, should be designed deliberately rather than inherited.
- **Bull queue import — delete.** Crystal's `CLAUDE.md` mentions Bull (a Redis-backed job queue) but the actual production code uses an in-process `SimpleQueue`. The risk of leaving the Bull references in `CLAUDE.md` is that a future reader assumes Redis is required and wastes time setting it up. Delete the references along with any unused imports.
- **Linux/Windows specific paths — delete.** Crystal supports all three platforms with conditional code throughout (different PTY libraries, different filesystem conventions, GTK-3 workarounds). Cyboflow v1 is macOS-only. Every line of cross-platform code is one you have to read and potentially debug for a platform you're not running. The cost is paid in cognitive overhead, not raw time — important when Claude Code is doing most of the writing and you're the reviewer.
- **AI worktree naming — delete.** Crystal's `WorktreeNameGenerator` calls Claude to generate human-readable branch names from prompts. This adds an API hop at session start (slower), fails offline, produces non-deterministic names, and can collide. The deterministic scheme `cyboflow/<workflow>/<runId8>` is sortable, greppable, and namespaced — `git branch -D 'cyboflow/*'` scrubs everything cleanly.
- **Multi-panel-per-session UI surfaces — delete.** Crystal's mental model is "a session hosts multiple AI agent panels side-by-side to compare approaches." Cyboflow's model is 1:1 — one workflow run = one agent = one worktree. Exposing the multi-panel UI would actively confuse the product story; users would see "add another agent to this session" and wonder what it means. The underlying data model can keep the panel abstraction temporarily (collapse "session = one panel" rather than refactoring tables on day one), but the UI surfaces that let users create multiple panels must be removed.
- **Rebase/squash UI in v1 — hide, keep the code.** Crystal has substantial UI for git operations on worktree branches (rebase onto main, squash, merge back). These are plausible v2 features but irrelevant to v1's "concentrate human attention" thesis. The code is good code that probably works; deleting it is destructive because re-implementation would be the alternative if v2 brings these features back. Hide the entry points (the UI buttons that invoke the code) to get the simplification benefit without burning the optionality.

The decision rule for any related judgment call the planner faces: if the code would *mislead a future reader about the product*, delete it. If it's just out-of-scope-for-now but might return in v2, hide the entry points and leave the implementation in place.

**License posture.** Crystal is MIT throughout. The fork carries no AGPL contamination. The Nimbalyst rename and its team-collaboration AGPL layer live in a separate repository and are not relevant. Do not merge upstream from Nimbalyst.

---

## 4. Architectural Principles

**Orchestrator/UI separation.** The orchestrator — workflow execution, Claude session management, state mutations, MCP server hosting — is a self-contained module inside the Electron main process, not entangled with Electron APIs. All renderer → orchestrator communication goes through a typed tRPC router. This is the only insurance against a painful backend-extraction in 12 months. When team-tier comes, the orchestrator becomes a Node service, the `ipcLink` swaps for `httpLink + wsLink`, and renderer call sites are unchanged.

**Database is a service, not a file.** The orchestrator owns all database mutations. The renderer never writes to SQLite directly; it goes through tRPC mutations. This preserves the option of moving the database behind a network service in v2 without rewriting the client.

**The MCP server is a separate process from day one.** Even in v1 where it's bundled in the same binary, the cyboflow MCP server runs as a stdio subprocess spawned by the orchestrator. It talks to the orchestrator over a private Unix socket. Same shape as a future "MCP server runs on the team backend" deployment, just running locally.

**Typed events at the parser boundary, trusted types inside.** Stream-json from Claude Code is validated with Zod at the parsing boundary and converted into a discriminated TypeScript union. Inside the orchestrator and renderer, the types are trusted — no defensive parsing, no `any`. The boundary is the contract; the interior is the application.

**Append-only audit log, normalized projections.** Every parsed stream event lands as one row in a `raw_events` table before any reducer interprets it. Normalized projections (`messages`, `approvals`, `workflow_runs`) are derived from raw events. If a downstream reducer turns out wrong, history is replayable. This is the discipline that turns "non-deterministic state machinery" — the pain Krishna flagged in SoloFlow markdown-as-state — into a tractable system.

**Per-run mutex on all mutations.** Each workflow run has its own `p-queue({concurrency: 1})` in the orchestrator. Every state change for that run — appending a message, creating an approval, transitioning status, accepting a decision — goes through the queue. This serializes against the inevitable races between Claude events arriving and user actions firing concurrently.

**Pause must be enforced, not requested.** Tool-use approvals interrupt Claude via the synchronous `--permission-prompt-tool` socket bridge. Claude blocks awaiting a socket reply; Cyboflow holds the reply until the user decides. Post-hoc inspection of stream events for "Claude is about to do X" is not acceptable as a pause mechanism — by the time the event arrives, X has already happened.

---

## 5. The Eight Primitives

The system decomposes into eight primitives. Six are substantially solved by forking Crystal. Two — stream extraction and the review queue — are load-bearing and must be designed from scratch even in the fork path.

### 5.1 Concurrent PTY Sessions
Spawn one `claude -p --output-format stream-json --verbose --include-partial-messages` per workflow run, each in its own `node-pty` PTY, with the worktree directory as cwd. Cap concurrency at 8 product-level (Crystal allows 5 on macOS, 1 on Linux at the queue level — keep these caps).

The completion gate is *not* the `result` event alone (Claude Code issue #1920 documents cases where it never arrives). Use `(child exited) AND (stdout EOF) AND (parser queue drained)`, with a 30-second watchdog grace period after child exit before forcing the run into `failed`.

Lift directly from Crystal: `AbstractCliManager`, `CliManagerFactory`, `SimpleQueue`, zombie-process detection.

### 5.2 Stream Extraction (LOAD-BEARING)

Two layers, both critical.

**Layer A — the parsing pipeline.** PTY stdout (bytes) → `LineBufferer` (carries partial lines across chunks) → `JSONParser` (per-line, never throws into the event loop, parse errors are logged and dropped) → `TypedEventNarrowing` (Zod schema with `.passthrough()` + a default `unknown` variant) → `EventRouter` (per-runId fanout to consumers).

**Layer B — the event-to-UI flow.** EventRouter dispatches to: (a) `raw_events` table for audit, (b) `sessionSlice.appendMessage()` for the conversation panel, (c) `reviewQueueSlice.maybeEnqueue()` for the cross-workflow queue, (d) `usageSlice.accumulate()` for cost meter, (e) `workflowSlice.advance()` for the state machine.

**The typed event union** is the contract between the parser and everything downstream. Lock it before writing the parser. The seven variants:

```ts
type ClaudeStreamEvent =
  | SystemInitEvent           // tools, MCP servers, cwd, model, permissionMode
  | SystemRetryEvent          // attempt, errorStatus, error category
  | SystemCompactEvent        // context compaction boundary
  | AssistantMessageEvent     // messageId, blocks: (text | thinking | tool_use)[], usage
  | UserMessageEvent          // messageId, blocks: (text | tool_result)[]
  | StreamDeltaEvent          // partial deltas (only with --include-partial-messages)
  | ResultEvent               // totalCostUsd, durationMs, numTurns, permissionDenials
  | ErrorEvent;               // reason, recoverable
```

The `assistant.message` variant carrying a `tool_use` block is the single event that drives the differentiator. When such a block appears and the workflow policy requires approval, the orchestrator writes an `approvals` row, transitions the run to `awaiting_review`, and holds the permission-socket reply until the user decides.

**Crystal's parser sits on the renderer side and operates on raw JSONL strings over IPC.** This is the wrong process boundary for Cyboflow — the orchestrator needs typed events too, to drive the state machine and the review queue. The parser must move to `main/` behind a `ClaudeStreamParser` class. Both the renderer (via tRPC subscription) and the internal orchestrator consumers subscribe to the same typed event stream.

### 5.3 Task State Management

SQLite via `better-sqlite3`, WAL mode, single-process. Hand-rolled migrations following Crystal's pattern (don't reach for an ORM). DB location: `~/.cyboflow/cyboflow.db`.

> **Entity model + review queue (post-MVP rebuild — current source of truth).** The "five new tables" framing below is the original run-substrate design and is still accurate for the *run* tables (`workflows`, `workflow_runs`, `raw_events`, `messages`, `approvals`). On top of it, the app now persists a **DB-canonical 3-table entity model** — `ideas` / `epics` / `tasks` (migration 015), each with its own columns + a single markdown `body`, sharing **one 12-stage board** (union view across all three types, terminal `Decomposed` stage for retired ideas). A polymorphic `entity_events` audit log replaces the task-scoped `task_events`. All entity writes funnel through the single `TaskChangeRouter.applyChange` chokepoint. A unified **`review_items`** inbox (migration 016) backs the review queue: `kind in (finding|permission|decision|human_task)`, per-item `blocking`, a soft polymorphic `(entity_type, entity_id)` entity link, all writes through `ReviewItemRouter`. The planner/sprint agents write the entity model exclusively via the `cyboflow_*` MCP tools (`cyboflow_create_task`, `cyboflow_report_finding`, …) — never markdown state files. See `docs/ARCHITECTURE.md` "Data Model" for the authoritative table-by-table breakdown and `docs/CODE-PATTERNS.md` for the chokepoint patterns.

**Five new tables on top of Crystal's existing schema (original run-substrate design):**

- `workflows` — registry of the built-in flow definitions (Planner + Sprint + Compound), keyed by project
- `workflow_runs` — single execution of a workflow on a worktree; the central entity
- `raw_events` — append-only audit log, one row per parsed stream event
- `messages` — normalized conversation messages, derived from raw events for cheap reads
- `approvals` — pending and decided tool-use approvals; the differentiator's persistence
- `checkpoints` — optional MVP+1, phase transitions for compound learning

**State machine on `workflow_runs.status`:**

```
queued → starting → running ─┬→ awaiting_review → running (loop)
                             ├→ completed
                             ├→ failed
                             └→ canceled
```

Every transition into `awaiting_review` is co-written with an `approvals` row in the same SQLite transaction (`BEGIN IMMEDIATE`). Every transition out of `awaiting_review` is co-written with the decision update. The renderer never writes the DB directly — all state changes go through orchestrator-owned tRPC mutations, serialized through the per-run mutex.

Crystal's existing `sessions`, `tool_panels`, `panel_outputs`, `panel_messages`, `prompt_markers`, `execution_diffs` tables stay in the schema. Cyboflow writes to the new tables; Crystal's tables coexist but are not the source of truth for Cyboflow workflows.

### 5.4 Worktree Lifecycle

One worktree per workflow run. Deterministic naming: `cyboflow/<workflow-name>/<runId8>` (e.g. `cyboflow/sprint/a3f2b1c0`). Worktree parent directory: `<repo>/.cyboflow/worktrees/` — inside the repo to play well with the user's `.gitignore`, namespaced to avoid colliding with anything else.

Branch off `main` by default (configurable per workflow). On completion, keep the worktree until the user manually merges or archives — no auto-cleanup in v1. On cancel or failure, optional auto-remove after N days (default: never; opt-in). Cleanup is `git worktree remove --force` then `git branch -D` if the branch hasn't been merged. Safety: refuse to remove if `git status --porcelain` is non-empty unless the user explicitly opts to discard changes.

Lift Crystal's `WorktreeManager` wholesale; the only change is replacing `WorktreeNameGenerator` (which calls Claude for a human-readable name) with the deterministic scheme. Weekly `git worktree prune` to clean up orphan metadata.

### 5.5 macOS Wrapper

Universal binary (x64+arm64) packaged as a signed and notarized DMG. Code signing via Apple Developer ID, hardened runtime entitlements, notarization via `notarytool` with credentials stored in keychain (`xcrun notarytool store-credentials AC_PASSWORD`).

Native modules — `better-sqlite3` and `@homebridge/node-pty-prebuilt-multiarch` — rebuilt against Electron's Node ABI via `@electron/rebuild` postinstall, with `asarUnpack` patterns to expose the `.node` binaries at runtime.

Window: `BrowserWindow` with `titleBarStyle: 'hiddenInset'`, `contextIsolation: true`, `nodeIntegration: false`. Single-instance lock via `app.requestSingleInstanceLock()`. Dock badge bound to `reviewQueueSlice.queue.length` — the pending-approval count is the app's headline affordance.

No auto-update in v1. Distribution is a direct DMG download from a GitHub release page; v1.1 can add `electron-updater`.

Lift Crystal's `electron-builder` configuration entirely. Change only the appId, app icon, and signing identity.

### 5.6 MCP Server Lifecycle

> **Tool surface updated (entity-model rebuild).** The read-only "minimal v1" surface sketched below was superseded once the flows became self-contained: agents now WRITE the DB-canonical entity model and review inbox through the MCP runtime — `cyboflow_report_step` (workflow progress), `cyboflow_create_task` and the other entity task-write tools (routed through `TaskChangeRouter.applyChange`), and `cyboflow_report_finding` (non-blocking review_items via `ReviewItemRouter`). The "resist write-state tools" guidance below no longer holds; the human-in-the-loop is preserved instead by the blocking-`review_items` gate (permissions + decisions) and the aggregate-unblock rule. The `cyboflow_*` MCP tools are the ONLY way agents touch the backlog — never markdown state files. See `docs/ARCHITECTURE.md` and the orchestrator `mcpServer/` sources for the live surface.

A `CyboflowMcpServer` runs as a stdio subprocess spawned by the orchestrator at app start. The original read-only sketch was:

- `cyboflow_list_pending_approvals` — read access to the current review queue
- `cyboflow_get_run` — fetch a workflow run's state by ID
- `cyboflow_submit_checkpoint` — write a checkpoint marker from inside a Claude session

The MCP server is configured per-Claude-session via a `.mcp.json` file written into the worktree before `claude -p` is invoked. Per-session scoping is achieved by injecting `CYBOFLOW_RUN_ID` and `CYBOFLOW_ORCH_SOCKET` into the MCP server's environment so it can disambiguate which run a tool call is coming from. The MCP server talks back to the orchestrator over a private Unix socket.

One write boundary stays off-limits even now: agents never *approve* from inside Claude (no "approve from inside Claude" tool) — the human-in-the-loop on permission/decision review items is the product. Agents DO write backlog state (tasks, findings, step progress) through the entity-model chokepoints, but they cannot resolve their own blocking review items; that gate remains human-only.

The pattern is templated from Crystal's `PermissionIpcServer` but is new code — Crystal does not have an outbound MCP server today.

### 5.7 Human Review Queue (LOAD-BEARING DIFFERENTIATOR)

> **Generalized to a unified inbox (`review_items`).** This section was written when the queue held only tool-use *approvals*. The shipped queue (`<ReviewQueueView />`) is the unified `review_items` inbox: `finding | permission | decision | human_task`, each with a per-item `blocking` flag. Permissions fold the approval path described below (`blocking=true`); decisions come from the `approve-idea` / `approve-plan` human gates and AUTO-RESUME the run on resolution subject to **aggregate-unblock** (a run stays `awaiting_review` until ALL its blocking items resolve); findings are non-blocking and live in a SEPARATE UI section so blocking items stay prominent; human tasks are manual to-dos (blocking per item). Triage can resolve / dismiss / promote a finding to a real task. All writes go through `ReviewItemRouter`. Each card opens the idea/epic/task detail editor via a dedicated **Edit** affordance (not full-card click). The approval-specific data flow below remains accurate for the `permission` kind.

**The product, made concrete.** A workspace-scoped left rail (or top tab) called `<ReviewQueueView />` lists all pending review items across every running flow. An approval card shows: flow name, tool name (e.g. "Bash"), payload preview (the command or file edit), Claude's preceding rationale text, age, and Approve / Reject buttons. Sorted oldest-pending first; blocking items pinned to top. Dock badge shows count.

**The data flow.** Stream parser emits an `assistant.message` with a `tool_use` block. `ApprovalRouter` (a main-process module) consults the workflow's policy (per-workflow frontmatter parsed at run start). If approval is required: transaction-write the `approvals` row, transition the run to `awaiting_review`, hold the permission-socket reply, push the event to renderer via tRPC subscription. Renderer's `reviewQueueSlice` reducer adds the item to the queue. User clicks Approve in `<PendingApprovalCard />`. tRPC mutation reaches `ApprovalRouter`, which under the per-run mutex: transaction-updates the approval row, transitions the run back to `running`, replies on the permission socket with `allow`. Claude resumes.

**The pause mechanism.** Crystal's `PermissionIpcServer` provides this directly — Claude is spawned with the socket path in `MCP_PERMISSION_SOCKET`, and any tool invocation routes through the synchronous permission-prompt-tool which blocks on socket reply. This is gold and the single biggest reason to fork Crystal. The only change is what the socket request does on the Cyboflow side: instead of routing to Crystal's per-panel modal, route to `ApprovalRouter` and let it drive the workspace queue.

**Policy.** Per-flow, defined in the frontmatter of the in-repo prompt files (`main/src/orchestrator/workflows/*.md`). Both shipped flows — `planner.md` and `sprint.md` — declare `permission_mode: default` (everything prompts), the conservative posture for v1. The other modes in the contract (`acceptEdits` = file edits auto-allow / bash prompts; `dontAsk` = explicit allowlist) remain valid `PermissionMode` values a future or edited flow can adopt. Policy is parsed at run start (`WorkflowRegistry`) and stored as the `permission_mode_snapshot` on the `workflow_runs` row.

**Failure modes that are non-negotiable to handle correctly:**
- Pause must actually block Claude — never use post-hoc event inspection
- Approval timeout (default 60 min) must reply on the socket with deny, not just expire silently
- Race between user approval and run failure must be handled under the per-run mutex (status check before applying the approval)
- Cross-run deadlock detection: if a run is awaiting review for >5 min and that review is itself paused on another run's tool call, flag as `stuck`

### 5.8 IPC Layer

**The principle.** All renderer ↔ orchestrator communication for Cyboflow-specific functionality goes through a typed tRPC router. Crystal's existing `ipcMain.handle`-based IPC stays for inherited functionality (worktree management, git operations, file ops) — don't refactor what works. New code uses tRPC, namespaced as `cyboflow.*` to disambiguate from Crystal's `sessions:*`, `panels:*`, etc.

**Router shape:**

```ts
appRouter = t.router({
  cyboflow: t.router({
    runs:      t.router({ list, start, cancel, get }),
    approvals: t.router({ listPending, approve, reject }),
    workflows: t.router({ list, get }),
    events:    t.router({ onStreamEvent, onApprovalCreated })
  })
});
```

`superjson` as transformer for Date/BigInt fidelity. Subscriptions implemented as Observables — perfect fit for streaming Claude events to the renderer. Backpressure: throttle subscription broadcast at 60Hz; full event fidelity persists to `raw_events` regardless.

**The extraction story.** When team-tier comes, `ipcLink` is swapped for `httpLink + wsLink`. The orchestrator extracts to a Node service. Renderer call sites are unchanged. The auth principal that today is `{ userId: 'local' }` becomes a real authenticated identity. Build the principal pattern into the tRPC context from day one so adding real auth is a swap, not a refactor.

---

## 6. Day-1 Architecture Discipline

Three commitments to lock before writing application code. They cost roughly one combined day to set up and prevent days of week-2 firefighting.

**6.1 Freeze the typed event schema first.** Before writing the parser, write `shared/types/claudeStream.ts` with the seven-variant discriminated union. The parser is a pure function from `string → ClaudeStreamEvent`. The reducers are pure functions from `ClaudeStreamEvent → Partial<State>`. The contract is the union — everything downstream is mechanical.

**6.2 Move Crystal's transformer from renderer to main on day one.** Crystal's `ClaudeMessageTransformer` (renderer-side, raw-JSONL input) is the wrong shape for Cyboflow. The first significant refactor on the fork is to extract this into `main/src/services/streamParser.ts`, emit typed events on an internal `EventEmitter`, and have the renderer subscribe via tRPC instead of consuming raw JSONL. Do this before building anything on top.

**6.3 Build the orchestrator as if it's a separate process.** Even though it runs inside Electron's main process in v1, structure it as: a single entry point (`Orchestrator` class), a tRPC router that's its only public surface, no Electron imports inside the orchestrator module, a clean `start()`/`stop()` lifecycle. The renderer talks to it only through tRPC. When team-tier extraction comes, this module gets lifted into a Node server with minimal changes.

---

## 7. Known Risks and Mitigations

**Stream-json schema drift.** Anthropic ships changes to the event format without SemVer bumps. The Zod schema uses `.passthrough()`, the parser logs unknown event kinds at WARN level, and the orchestrator never crashes on an unrecognized event. CI integration test pins a specific Claude Code version and runs an end-to-end smoke test on every Cyboflow release.

**Claude Code `result` event missing (#1920).** Never use `result` as the only completion signal. Completion gate is `(child exited) AND (stdout EOF) AND (parser queue drained)` with a 30-second watchdog after child exit.

**Approval expires while held.** A user starts approving, walks away, hits a 60-minute timeout. The expiration handler must reply on the permission socket with deny, not just mark the approval `expired` in the DB. Otherwise Claude hangs forever waiting on the socket.

**Universal-binary native module mismatch.** `better-sqlite3` and `node-pty` must be rebuilt for both x64 and arm64 in the universal DMG. `npmRebuild: true` in electron-builder config; verify with `lipo -info` on the `.node` files in the built app.

**Crystal substrate fighting the differentiator.** Mitigation gate: by end of day 3, two runs in different workflows must each be able to be paused on the queue, and the user must be able to approve them in any order. If by day 3 the per-panel architecture is fighting this — e.g. the queue view requires touching 20+ files — Path A's leverage has evaporated and a greenfield reset becomes worth considering.

**Crystal is deprecated.** No upstream improvements after the fork; Cyboflow owns all future maintenance of the inherited code. This is fine because the inherited surface (PTY management, worktree lifecycle, packaging) is stable in scope. Don't merge from Nimbalyst — different license posture, different product direction.

**Notification fatigue.** Five runs all hitting Bash approvals at once will bury the user. v1 mitigation: collapse repeated approvals from the same run into a summary card. v2: AI-assisted auto-approval for safe-pattern bash.

**Backend extraction debt.** electron-trpc gives a clean call-site boundary, but the orchestrator mutates SQLite directly. Backend extraction in v2 also requires swapping `better-sqlite3` for a network DB or wrapping it in a node-IPC pattern over the same tRPC interface. Budget ~1 week for this in the team-tier rewrite — it's preserved as an option, not free.

---

## 7.5 Trust Boundaries

**Local Unix socket = trusted channel.** The cyboflow MCP server communicates with the orchestrator exclusively over a Unix domain socket at `CYBOFLOW_ORCH_SOCKET`. There is no authentication on this channel — it is process-local and accessible only to processes that know the socket path (which is injected by the orchestrator at session spawn time). Do not expose this socket over the network or to untrusted processes.

**Cross-run read scope is intentional.** `cyboflow_list_pending_approvals` returns approvals across *all* workflow runs (no `WHERE run_id = ?` filter). This is the design: the review queue is workspace-scoped, aggregating every pending approval regardless of which run produced it. Narrowing this SELECT to the caller's own `run_id` would break the day-3 review-queue UX. Similarly, `cyboflow_get_run` accepts any `targetRunId` — a running agent can inspect the status of sibling runs. Do NOT add a run-scoped WHERE clause to either handler without revisiting this product decision.

**Checkpoint run_id.** `cyboflow_submit_checkpoint` writes `run_id` from the caller's `CYBOFLOW_RUN_ID` env var. The singleton orchestrator server uses the sentinel value `orchestrator`, which has no matching `workflow_runs` row and would violate the `raw_events.run_id` foreign key. `handleSubmitCheckpoint` rejects the sentinel at the handler boundary — before any INSERT — returning `{ ok: false, error: 'checkpoint_requires_real_run' }`. Checkpoint calls from the singleton are refused with a structured error; only messages bearing a real workflow run ID reach the database. The test fixture runs with `foreign_keys = ON` and verifies that no row is inserted when `runId === 'orchestrator'`.

---

## 8. What's Explicitly Out of Scope for v1

Auto-update via `electron-updater`. Codex / OpenAI integration. Linux or Windows builds (macOS-only). AI-driven worktree naming. Crystal's rebase/squash UI. Multi-panel-per-session UI surfaces. Cross-machine sync. Cloud agents. Custom DAG editor. Workflow versioning. Multi-user. Authentication. SSO. Team review queues. Edit-plan and request-changes flows (Approve/Reject only). Cost estimation from historical data (static estimates fine, or omitted). Streaming partial JSON for tool inputs (parse on `content_block_stop` only).

All of these are real things Cyboflow may want eventually. None of them are part of validating the human-attention thesis. Anything that doesn't directly demonstrate "agent work concentrates into a review queue that I clear in 5 minutes" gets cut.

---

## 9. Repository and Workflow Posture

**Project location.** `~/Developer/cyboflow`

**Fork source.** `stravu/crystal` at HEAD, MIT-licensed

**Workflow self-containment (was "SoloFlow integration").** The first Cyboflow flows were adapted from SoloFlow workflows; the P0 rip-out brought their prompt bodies **into the app source** (`main/src/orchestrator/workflows/planner.md` + `sprint.md` + `compound.md`) and severed the runtime dependency on the SoloFlow plugin cache (`~/.claude/plugins/cache/soloflow/...`). The shipped app exposes three built-in flows — **Planner**, **Sprint**, and **Compound** — keyed by `CYBOFLOW_WORKFLOW_NAMES` in `shared/types/workflows.ts`; `compound` was rebuilt natively from the preserved prose. The dropped `soloflow` / `prune` flows have their prose preserved under `docs/workflows-future/`. Agents write the DB via the `cyboflow_*` MCP tools, not markdown state files. The reason Cyboflow exists is because the plugin approach was fundamentally limited in its capability to execute these workflows effectively — Cyboflow now owns the full flow definitions natively.

**Development tooling (historical).** Cyboflow's own development was previously tracked by the SoloFlow dev plugin under `.soloflow/`; that plugin and directory have since been removed. The shipped app never had any runtime dependency on it.

**Crystal commit pinning.** Pin to current HEAD of `stravu/crystal` at fork time. Tag the pinned commit in the Cyboflow README. Do not pull from Crystal or Nimbalyst after fork.
