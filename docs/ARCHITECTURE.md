# Architecture

## Purpose

Cyboflow is a macOS desktop app that orchestrates Claude Code as a multi-agent workflow runner.
Users select one of five pre-set SoloFlow workflows, the app spawns Claude Code in an isolated
git worktree per run, streams and parses its structured output, and surfaces tool-use approvals
in a workspace-scoped cross-workflow review queue. The review queue — a single pane aggregating
pending approvals from all running workflows — is the product differentiator.

This codebase is forked from `stravu/crystal` at tag `0.3.5` (commit `1e18e0b`). Crystal
branding, IPC transport, and Crystal-specific features are being progressively replaced. See
`docs/cyboflow_system_design.md` for the full product spec and cut decisions.

## Entry Points

- **`main/src/index.ts`** — Electron main process bootstrap; registers IPC handlers, starts
  the orchestrator services, opens the BrowserWindow.
- **`main/src/preload.ts`** — Electron preload script; exposes the IPC bridge to the renderer
  via `contextBridge`.
- **`frontend/src/main.tsx`** — React renderer bootstrap; mounts `<App />`.
- **`frontend/src/App.tsx`** — Root React component; top-level routing and layout.

## Top-Level Layout

- **`main/`** — Electron main process (Node.js). All orchestration, database writes, PTY session
  management, git operations, and IPC handlers live here.
- **`frontend/`** — React renderer (Vite + Tailwind). UI panels, Zustand stores, and frontend
  utilities. Never touches the database or filesystem directly.
- **`shared/`** — TypeScript types shared between `main/` and `frontend/`. The contract layer.
- **`docs/`** — Product spec, research package, reference designs, Crystal legacy docs.
- **`tests/`** — Playwright E2E tests run against a live Electron instance.
- **`scripts/`** — Build tooling: `inject-build-info.js`, `configure-build.js`.
- **`build/`** — Electron Builder config files: `afterSign.js`, `entitlements.mac.plist`.

## Major Components / Layers

### Orchestrator (`main/src/orchestrator/`)

`Orchestrator` (`main/src/orchestrator/Orchestrator.ts`) is the single lifecycle entry
point for the cyboflow main process. It is constructed via constructor injection. The
dependency bag (`OrchestratorDeps` in `main/src/orchestrator/types.ts`) has three required
collaborators and two optional narrow interfaces:

- **`db: DatabaseLike`** — narrow interface over better-sqlite3; no concrete import.
- **`logger: LoggerLike`** — structured log surface (info/warn/error/debug).
- **`runQueues: RunQueueRegistry`** — per-run mutation queue; `drainAll()` is awaited in `stop()`.
- **`claudeManager?: ClaudeManagerLike`** *(optional)* — narrow `hasActiveRunForId(runId)` interface used by `StuckDetector` to classify `orphan_pty` reasons. When omitted, that classification is effectively disabled.
- **`permissionServer?: PermissionServerLike`** *(optional)* — narrow `hasClientForRun(runId)` interface used by `StuckDetector` to classify `stale_socket` reasons. When omitted, `stale_socket` classification is disabled with a one-time WARN. The concrete server is **not yet built** — see "Planned / Not Yet Built" below.

`start()` is idempotent; `stop()` drains all run queues before resolving.

**Event bus decision (SPRINT-006):** No shared `eventBus: EventEmitter` exists on
`OrchestratorDeps`. Cross-component events (e.g., `runs:stuck` from `StuckDetector`) use
per-component `EventEmitter` instances created internally by each producer — not a
top-level shared bus. Future `ApprovalRouter → renderer` notifications follow the same
per-producer pattern: each component owns its emitter and callers subscribe directly.

Standalone-typecheck invariant: the entire `main/src/orchestrator/` subtree must compile
without transitive imports from `electron`, `better-sqlite3`, or any service in
`main/src/services/*`. This keeps the orchestrator extractable to a standalone Node process
for the team-tier v2 target (ROADMAP-001 §6.3).

**Documented exception:** `main/src/orchestrator/runEventBridge.ts` imports `EventRouter`,
`RawEventsSink`, and `TypedEventNarrowing` from `main/src/services/streamParser` at value
position. This is the ONLY accepted exception, permitted because `streamParser` itself has
clean runtime imports today (zod + `node:events`; `better-sqlite3` is type-only). If
`streamParser` ever pulls in `electron` or `better-sqlite3` at value position,
`runEventBridge.ts` must switch to constructor injection. Do NOT add value imports from
`services/*` to any other file under `orchestrator/**` without extending this list.

### Services (`main/src/services/`)

Core business logic services. Key components:
- **`cliManagerFactory.ts` / `panels/claude/claudeCodeManager.ts`** — Claude Code session
  lifecycle via the **Agent SDK** (`@anthropic-ai/claude-agent-sdk` `query()` in-process).
  No `claude` CLI binary is spawned and no PTY is used on this path. `ClaudeCodeManager`
  extends `AbstractCliManager` and overrides its spawn surface so the SDK's async-iterator
  drives session output directly (see `claudeCodeManager.ts:4`, header docstring lines 79–84).
  Approval routing flows through SDK **PreToolUse hooks**, not the deprecated
  `--permission-prompt-tool` CLI flag — see `permissionModeMapper.ts` (`buildPreToolUseHook`)
  and `preToolUseHookHelper.ts` (`routePreToolUseThroughApprovalRouter`).
- **`panels/cli/AbstractCliManager.ts`** — Intentional extension surface (per
  `cyboflow_system_design.md:64`). Still owns the PTY spawn path (`spawnPtyProcess`); kept
  in place even though `ClaudeCodeManager` no longer routes through it, so future CLI tools
  can be added as additional subclasses.
- **`panels/claude/interactiveClaudeManager.ts`** — The **interactive (subscription-billed)**
  Claude substrate (IDEA-013), a sibling of the SDK `ClaudeCodeManager`. It drives a REAL
  interactive `claude` REPL over the inherited `AbstractCliManager` PTY machinery (no headless
  `-p` flag, no stream-json output flag) and recovers structured panel fidelity out of band via
  a `TranscriptTailSource`. `workflow_runs.substrate` ('sdk' | 'interactive') is stamped at
  launch and dispatched by the `SubstrateDispatchFacade`.

#### Interactive-substrate workflow step tracking

The Workflow Progress panel advances on interactive-substrate runs through the **exact same
MCP-driven chain** the SDK substrate uses (scope decision #3: step tracking comes from
`cyboflow_report_step`, NOT from parsing the transcript stream). The MAIN orchestrating
interactive `claude` session calls the `cyboflow_report_step` MCP tool → `OrchSocketServer` →
`handleReportStep` → `buildStepTransitionEvent` (`stepTransitionBridge.ts`) →
`stepTransitionEvents.emit('transition', …)` → the `onStepTransition` subscription →
`mergeTransition` (`useWorkflowPhaseState.ts`), advancing the panel with zero renderer changes.
Two substrate-specific seams make this work and are the only interactive-side additions:
- **`CYBOFLOW_RUN_ID = workflow_runs.id`** is injected into the interactive PTY env (the real
  run id, NOT the discovered Claude session UUID) so the handler binds a real `workflow_runs`
  row.
- **Prompt-body prepend**: interactive `claude` has no SDK `systemPrompt.append` channel, so the
  per-run step-reporting instruction (`buildStepReportingAppend`, built from the run's EFFECTIVE
  `resolveWorkflowDefinition(name, spec_json)` — the dynamic, user-editable step-id model) is
  concatenated to the HEAD of the prompt written to PTY stdin. This is the interactive analogue
  of the SDK manager's `composeSystemPromptAppend` (`claudeCodeManager.ts:478`). Fail-soft: a
  non-SoloFlow / broken-spec run resolves to a `null` definition and prepends nothing.

**v1 limit — main-session-only step reporting.** Only the MAIN orchestrating session can call
`cyboflow_report_step`. Agent-tool **subagents** run in isolated sub-sessions that inherit
**neither** the `mcpServers` config **nor** the parent's hook scope (the same inherited IDEA-029
limit), so they cannot report steps — even though the PreToolUse shell hook itself does fire for
subagents (Probe A2). This ties directly to the **S5/TASK-810** subagent gating decision:
interactive selection is restricted for subagent-spawning workflows OR the `Task` tool is
force-denied, so a delegated step is always reported from the main session. Per-subagent step
reporting is explicitly out of scope for v1.
- **`terminalSessionManager.ts` / `terminalPanelManager.ts` / `runCommandManager.ts`** —
  These three services are the remaining live users of `@homebridge/node-pty-prebuilt-multiarch`
  (terminal panel and script execution surfaces — unrelated to Claude).
- **`simpleTaskQueue.ts`** — In-process concurrency queue (no Redis). Wraps `p-queue`.
  Used for session mutation serialization.
- **`worktreeManager.ts`** — `git worktree add -b ...` lifecycle; collision-safe naming;
  background cleanup.
- **`database.ts`** — `better-sqlite3` wrapper, WAL mode, hand-rolled migration runner.
- **`sessionManager.ts`** — Coordinates session state across services.

> The previously documented `permissionIpcServer.ts` does not exist as a service today —
> the file is owned by the future approval-router epic. See "Planned / Not Yet Built".

### IPC Layer

Two parallel surfaces are wired today:

1. **Raw Electron IPC** under `main/src/ipc/` — one file per domain (`session.ts`, `git.ts`,
   `panels.ts`, `cyboflow.ts`, etc.). `main/src/ipc/index.ts` registers all handlers at boot.
2. **tRPC via `trpc-electron`** under `main/src/orchestrator/trpc/` — the root `appRouter`
   in `router.ts` exposes all procedures under a single `cyboflow` namespace
   (`cyboflow.runs.*`, `cyboflow.approvals.*`, `cyboflow.workflows.*`, `cyboflow.events.*`,
   `cyboflow.health.*`). The renderer uses the typed tRPC client via the bridge wired in
   `main/src/preload.ts:2` (`exposeElectronTRPC`) and attached in `index.ts:686`.

The tRPC surface is now the canonical transport for all `cyboflow.*` channels. The
`trpc-cutover-and-legacy-tree-cleanup` epic (TASK-713 through TASK-717) completed the
migration: the four raw-IPC channels (`cyboflow:listWorkflows`, `cyboflow:startRun`,
`cyboflow:listRuns`, `cyboflow:mcp-health`) have been replaced by
`cyboflow.workflows.list`, `cyboflow.runs.start`, `cyboflow.runs.list`, and
`cyboflow.health.mcpServer` respectively. The unwired duplicate tRPC tree that previously
lived in `main/src/trpc/` has been deleted (TASK-717).

#### cyboflow.* transport status

**Raw-IPC stub** — handler present in `main/src/ipc/cyboflow.ts` but returns NOT_IMPLEMENTED:
- `cyboflow:approveRun` — approve / deny a day-3 gate approval. Full implementation
  lands in the approval-router epic (epic 7).

The renderer is fully cut over to tRPC for all data-plane `cyboflow.*` procedures except
the `cyboflow:stream:<runId>` push channel and the `cyboflow:approveRun` stub above.

**tRPC live** — all procedures in `main/src/orchestrator/trpc/routers/` with real
implementations wired today:
- `cyboflow.workflows.list` — list/seed workflows for a project.
- `cyboflow.workflows.get` — fetch a single workflow by ID.
- `cyboflow.runs.list` — list `workflow_runs` rows for a project (newest first).
- `cyboflow.runs.start` — launch a new workflow run.
- `cyboflow.runs.cancel` — cancel an in-flight run via `setCancelDeps()` injection.
- `cyboflow.runs.cancelAndRestart` — cancel a stuck run and enqueue a fresh run.
- `cyboflow.runs.getStuckInspection` — diagnostic data for a stuck run (stuck reason,
  pending approval payload, latest raw_events rows). Delegates to
  `getStuckInspectionHandler` in `main/src/orchestrator/inspectorQueries.ts`.
- `cyboflow.health.mcpServer` — point-in-time MCP server health snapshot.
- `cyboflow.approvals.listPending` — list all pending approvals across runs.
- `cyboflow.approvals.approve`, `cyboflow.approvals.reject` — resolve an in-flight
  decisionPromise via `ApprovalRouter.respond()`.
- `cyboflow.approvals.approveRestOfRun`, `cyboflow.approvals.rejectRestOfRun` — per-run
  batch decision procedures.
- `cyboflow.events.onApprovalCreated`, `cyboflow.events.onApprovalDecided`,
  `cyboflow.events.onStreamEvent`, `cyboflow.events.setBadgeCount` — push subscriptions
  and badge management.

All procedures are consumed by their respective Zustand stores and React components.

### Renderer (`frontend/src/`)

- **`components/panels/`** — Per-panel React components. Panel-type subdirs present today:
  `ai/` (abstract base), `claude/`, `cli/`, `diff/`, `editor/`, `logPanel/`. The Crystal-era
  `codex/` panel has already been removed.
- **`stores/`** — Zustand slices, one per domain:
  - Crystal-baseline: `sessionStore`, `panelStore`, `configStore`, `navigationStore`,
    `errorStore`, `sessionHistoryStore`, `sessionPreferencesStore`, `slashCommandStore`.
  - Cyboflow-era: `cyboflowStore` (workflows & runs), `mcpHealthStore` (sidebar dot),
    `reviewQueueStore` + `reviewQueueSlice` (cross-workflow approvals pane — the product
    differentiator).
- **`utils/api.ts`** — Thin IPC call wrapper used by all frontend components for raw IPC.
- **`utils/cyboflowApi.ts`** — Helper for the raw `cyboflow:*` channels.
- **`trpc/client.ts`** *(via `trpc-electron` client)* — Typed entry point for
  `cyboflow.*` procedures defined in `main/src/orchestrator/trpc/routers/`.

### Shared Types (`shared/types/`)

Both packages import from here via `../../../shared/types/...`. Changing types here is a
cross-package concern.

- **Crystal-baseline:** `models.ts`, `panels.ts`, `cliPanels.ts`, `aiPanelConfig.ts`.
- **Cyboflow-era:** `cyboflow.ts`, `workflows.ts`, `approval.ts`, `approvals.ts`,
  `mcpHealth.ts`, `stuckDetection.ts`, `stuckInspection.ts`, `claudeStream.ts`,
  `unifiedMessage.ts`.
- **Transport contract:** `trpc.ts` re-exports the inferred `AppRouter` type from
  `main/src/orchestrator/trpc/router.ts` so the renderer's `trpc/client.ts` is fully typed
  without importing main-process code.

## Frameworks & External Dependencies

- **Electron 37.6.0** — Desktop shell. `electron-builder` for packaging/signing; `@electron/rebuild`
  for native module rebuilds against Electron's Node ABI.
- **React 19 + Vite 6** — Renderer. Tailwind CSS for styling; `clsx` + `tailwind-merge` via `cn()`.
- **Zustand 5** — Renderer state. One slice per domain; no Redux.
- **better-sqlite3 11.7.0** — SQLite, synchronous, WAL mode. Database lives at `~/.cyboflow/`
  (`main/src/utils/cyboflowDirectory.ts:60`). The legacy `~/.crystal/` path has already
  been removed.
- **@anthropic-ai/claude-agent-sdk 0.2.141** — In-process Claude Code invocation via `query()`
  and `PreToolUse` hooks for approval routing. This is the live path; no `claude` CLI binary
  is spawned.
- **@homebridge/node-pty-prebuilt-multiarch 0.12.0** — PTY sessions. Pre-built binaries;
  rebuilt for Electron ABI by `electron-builder install-app-deps` postinstall. Used today
  only by `terminalSessionManager`, `terminalPanelManager`, and `runCommandManager` —
  **not** by Claude.
- **@modelcontextprotocol/sdk 1.12.1** — For the cyboflow MCP server (runs as a stdio
  subprocess; entry point asar-unpacked, see below).
- **trpc-electron 0.1.2** — Typed `electron-trpc` bridge between the renderer client and
  the main-process `appRouter`.
- **p-queue 7.4.1** (via `simpleTaskQueue.ts` wrapper) — Per-run mutation serialization.
- **Playwright** — E2E tests only.

## Data Model

Schema in `main/src/database/schema.sql`; incremental migrations run in two phases inside
`DatabaseService.initialize()` (see `main/src/database/database.ts`):

- **Phase 1 — inline migrations** inside `runMigrations()`: hand-written `ALTER TABLE` /
  `CREATE TABLE` blocks gated on `PRAGMA table_info` checks and on `user_preferences` marker
  keys (e.g. `auto_commit_migrated`, `claude_panels_migrated`, `diff_panels_migrated`,
  `unified_panel_settings_migrated`, `folder_session_order_fix_applied`). These are the
  legacy Crystal-era migrations and run unconditionally on every boot (each block is
  idempotent via the marker check).

- **Phase 2 — file-based migrations** via `runFileBasedMigrations()` (added in TASK-151),
  called at the tail of `runMigrations()`: reads `main/src/database/migrations/NNN_*.sql`
  files (numeric prefix `NNN`), sorts them by prefix, and applies each whose
  `file_migration_applied:<filename>` key is not yet in `user_preferences`. The ledger
  uses the same `user_preferences` table as the inline markers; the
  `file_migration_applied:` prefix namespaces file-runner entries from inline ones.
  On upgrade installs, `runFileBasedMigrations()` also backfills
  `file_migration_applied:003_add_tool_panels.sql`, `...004...`, and `...005...` when
  the corresponding inline markers are present, so those files are never double-applied.

Central tables (Crystal baseline): `sessions`, `panels`, `execution_diffs`, `projects`.
Cyboflow-era additions (migration `006_cyboflow_schema.sql`): `workflows`, `workflow_runs`,
`raw_events`, `messages`, `approvals` — designed in system design §5.

Migration files present today under `main/src/database/migrations/`: `003_add_tool_panels.sql`,
`004_claude_panels.sql`, `005_unified_panel_settings.sql`, `006_cyboflow_schema.sql`, and
`007_add_stuck_reason.sql` (adds the `stuck_reason` column to `workflow_runs` used by
`StuckDetector`).

## Build & Run

```
pnpm dev                  # Start Electron dev (frontend Vite dev server + Electron)
pnpm build:mac:arm64      # Full macOS arm64 build → packaged app
pnpm typecheck            # Type-check all workspaces
pnpm lint                 # ESLint across all workspaces
pnpm test:e2e             # Playwright E2E (requires a built app)
```

### asarUnpack contract

`cyboflowMcpServer.js` is spawned as an external `node` subprocess (the
per-session Cyboflow MCP server). Node cannot execute files from inside an ASAR
archive, so the script must be placed **outside** the archive at package time.

`package.json` `build.asarUnpack` covers it with the glob:

```
"main/dist/main/src/orchestrator/mcpServer/**/*.js"
```

In a packaged build, electron-builder places the script at:

```
<app>.app/Contents/Resources/app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js
```

`scriptPath.ts` (`resolveMcpServerScriptPath`) resolves the script at runtime:

- **Packaged mode** — `path.join(process.resourcesPath, 'app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js')`.
  No filesystem writes occur; the file is already asar-unpacked.
- **Dev mode** — `path.join(__dirname, 'cyboflowMcpServer.js')` (the tsc-compiled
  sibling in `main/dist/main/src/orchestrator/mcpServer/`).

The result is memoized at module level (`cachedResolvedPath`). The old
read-from-asar / write-to-`~/.cyboflow/` extraction path has been removed (TASK-618).

The tsc emit layout for the main process is `main/dist/main/src/**` (mirroring
the source tree under `main/src/`). Any future subprocess script added under
`main/src/` that must be spawned externally in a packaged build needs a
targeted `asarUnpack` entry using the corresponding `main/dist/main/src/...`
path — avoid broad wildcards to minimise the unpacked-tree size.

See also `docs/packaging/root-deps-policy.md` for the workspace dependency
policy (which deps belong in `main/package.json` vs. root `package.json`, and
the list of confirmed dead dependencies pending removal).

## Planned / Not Yet Built

The pieces below are referenced in the codebase (interfaces, stubs, comments, or socket-path
injection points) but have no live implementation today. They are concentrated in the
**approval-router epic (epic 7)** with one transport-cutover follow-up.

### Approval-router epic (epic 7) — owns the gap

- **`permissionIpcServer`** — Unix-socket server that bridges renderer approval decisions
  back into the orchestrator and the cyboflow MCP server subprocess. Today only the path
  injection point is wired: `ClaudeCodeManager.setOrchSocketPath()` is called against this
  expected file, and `main/src/index.ts:533` throws
  `"cyboflow: orchSocketProvider not yet wired (epic 7 owns permissionIpcServer)"` when an
  attempt to wire it is made. `OrchestratorDeps.permissionServer?` is the narrow interface
  the orchestrator will consume once the server lands.
- **`cyboflow:approveRun`** (raw IPC) — handler exists and returns
  `NOT_IMPLEMENTED: cyboflow:approveRun is pending epic 7`.

### Team-tier v2 — long-horizon

The standalone-typecheck invariant on `main/src/orchestrator/**` keeps the orchestrator
extractable to a standalone Node service (ROADMAP-001 §6.3 — team-tier v2 target). No code
exists yet; the invariant is preventive.

## Decisions & Trade-offs

See `docs/cyboflow_system_design.md` §2 (stack), §3 (fork rationale, cuts), §4 (principles).
Key standing decisions: macOS-only v1; no Redis; no Codex/OpenAI; deterministic worktree names;
orchestrator self-contained inside Electron main (extractable to Node service for team tier).
