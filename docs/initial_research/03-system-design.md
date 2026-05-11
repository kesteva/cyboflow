# Cyboflow — System Design

A desktop agent orchestration platform that wraps SoloFlow workflows in a UI focused on concentrating human attention across parallel Claude Code runs.

---

## 1. Product Thesis

**The thing being built.** Cyboflow is a desktop app that orchestrates Claude Code as a multi-agent workflow runner. Users start one of five pre-set SoloFlow workflows against a repo; the app spawns Claude Code in an isolated git worktree per run, parses the structured stream-json output, surfaces the work in a custom UI, and pauses on tool-use approvals that bubble up to a workspace-scoped review queue.

**The differentiator.** Everyone in this category is competing on agent autonomy, parallelism, or hand-off ergonomics. Cyboflow's bet is that the scarce resource is *human attention*, not agent time. The cross-workflow review queue — a single pane that aggregates pending approvals from every running workflow — is the product. Everything else is the substrate that makes it possible.

**The user, the wedge, and what's out of scope.** The v1 user is a solo developer running multiple parallel SoloFlow workflows on their own repos. The wedge is workspace-scoped review concentration combined with native integration to existing SoloFlow markdown workflows. Out of scope for v1: cloud agents, teams, multi-user, auth, custom DAG editing, agent customization, workflow versioning, anything that requires a backend service.

**The two-week MVP.** A signed, notarized macOS app that can: pick one of five pre-set workflows, run it in a git worktree against a real repo, stream Claude Code's structured output into a custom UI, surface tool-use approvals in a workspace-scoped review queue, and reliably pause-and-resume runs based on human approval decisions.

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
- `@modelcontextprotocol/sdk` for the SoloFlow MCP server
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

**The MCP server is a separate process from day one.** Even in v1 where it's bundled in the same binary, the SoloFlow MCP server runs as a stdio subprocess spawned by the orchestrator. It talks to the orchestrator over a private Unix socket. Same shape as a future "MCP server runs on the team backend" deployment, just running locally.

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

**Five new tables on top of Crystal's existing schema:**

- `workflows` — registry of the five pre-set workflow markdown files, keyed by project
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

A `CyboflowMcpServer` runs as a stdio subprocess spawned by the orchestrator at app start. It exposes a minimal v1 tool surface to Claude Code sessions:

- `cyboflow_list_pending_approvals` — read access to the current review queue
- `cyboflow_get_run` — fetch a workflow run's state by ID
- `cyboflow_submit_checkpoint` — write a checkpoint marker from inside a Claude session

The MCP server is configured per-Claude-session via a `.mcp.json` file written into the worktree before `claude -p` is invoked. Per-session scoping is achieved by injecting `CYBOFLOW_RUN_ID` and `CYBOFLOW_ORCH_SOCKET` into the MCP server's environment so it can disambiguate which run a tool call is coming from. The MCP server talks back to the orchestrator over a private Unix socket.

Resist adding write-state tools (e.g. "approve from inside Claude") in v1 — the human-in-the-loop is the product. Tool surface expands in v2 when the surface area is better understood.

The pattern is templated from Crystal's `PermissionIpcServer` but is new code — Crystal does not have an outbound MCP server today.

### 5.7 Human Review Queue (LOAD-BEARING DIFFERENTIATOR)

**The product, made concrete.** A workspace-scoped left rail (or top tab) called `<ReviewQueueView />` lists all pending approvals across every running workflow. Each card shows: workflow name, tool name (e.g. "Bash"), payload preview (the command or file edit), Claude's preceding rationale text, age, and Approve / Reject buttons. Sorted oldest-pending first; blocking items pinned to top. Dock badge shows count.

**The data flow.** Stream parser emits an `assistant.message` with a `tool_use` block. `ApprovalRouter` (a main-process module) consults the workflow's policy (per-workflow frontmatter parsed at run start). If approval is required: transaction-write the `approvals` row, transition the run to `awaiting_review`, hold the permission-socket reply, push the event to renderer via tRPC subscription. Renderer's `reviewQueueSlice` reducer adds the item to the queue. User clicks Approve in `<PendingApprovalCard />`. tRPC mutation reaches `ApprovalRouter`, which under the per-run mutex: transaction-updates the approval row, transitions the run back to `running`, replies on the permission socket with `allow`. Claude resumes.

**The pause mechanism.** Crystal's `PermissionIpcServer` provides this directly — Claude is spawned with the socket path in `MCP_PERMISSION_SOCKET`, and any tool invocation routes through the synchronous permission-prompt-tool which blocks on socket reply. This is gold and the single biggest reason to fork Crystal. The only change is what the socket request does on the Cyboflow side: instead of routing to Crystal's per-panel modal, route to `ApprovalRouter` and let it drive the workspace queue.

**Policy.** Per-workflow, defined in frontmatter of the SoloFlow markdown files. SoloFlow workflows like `soloflow.md` and `prune.md` use `permission_mode: "default"` (everything prompts). `sprint.md` uses `acceptEdits` (file edits auto-allow, bash prompts). `compound.md` uses `dontAsk` with an explicit allowlist. Policy is parsed at run start and stored on the `workflow_runs` row.

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

## 8. What's Explicitly Out of Scope for v1

Auto-update via `electron-updater`. Codex / OpenAI integration. Linux or Windows builds (macOS-only). AI-driven worktree naming. Crystal's rebase/squash UI. Multi-panel-per-session UI surfaces. Cross-machine sync. Cloud agents. Custom DAG editor. Workflow versioning. Multi-user. Authentication. SSO. Team review queues. Edit-plan and request-changes flows (Approve/Reject only). Cost estimation from historical data (static estimates fine, or omitted). Streaming partial JSON for tool inputs (parse on `content_block_stop` only).

All of these are real things Cyboflow may want eventually. None of them are part of validating the human-attention thesis. Anything that doesn't directly demonstrate "agent work concentrates into a review queue that I clear in 5 minutes" gets cut.

---

## 9. Repository and Workflow Posture

**Project location.** `~/Developer/cyboflow`

**Fork source.** `stravu/crystal` at HEAD, MIT-licensed

**SoloFlow integration.** Cyboflow consumes SoloFlow workflows (`soloflow`, `planner`, `sprint`, `compound`, `prune`) installed from `kesteva/soloflow` as a Claude Code plugin. The orchestrator parses the workflow markdown files from `~/.claude/plugins/soloflow@soloflow/agents/` (or wherever the plugin install resolves them) at run start. Workflow frontmatter drives permission policy.

**Dogfooding from day one.** Cyboflow uses SoloFlow workflows to develop itself. The CLAUDE.md and ARCHITECTURE.md generated by `/soloflow:map-codebase` are the canonical agent context; this design doc is the input to `/soloflow:planner` for v1 epic decomposition.

**Crystal commit pinning.** Pin to current HEAD of `stravu/crystal` at fork time. Tag the pinned commit in the Cyboflow README. Do not pull from Crystal or Nimbalyst after fork.
