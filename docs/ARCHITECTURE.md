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
point for the cyboflow main process. It is constructed via constructor injection and
accepts exactly three collaborators:

- **`db: DatabaseLike`** — narrow interface over better-sqlite3; no concrete import.
- **`logger: LoggerLike`** — structured log surface (info/warn/error/debug).
- **`runQueues: RunQueueRegistry`** — per-run mutation queue; `drainAll()` is awaited in `stop()`.

`start()` is idempotent; `stop()` drains all run queues before resolving.

**Event bus decision (SPRINT-006):** A shared `eventBus: EventEmitter` field was removed
from `OrchestratorDeps` (it was never read by any caller after TASK-253). Cross-component
events (e.g., `runs:stuck` from `StuckDetector`) use per-component `EventEmitter` instances
created internally by each producer — not a top-level shared bus. Future `ApprovalRouter →
renderer` notifications follow the same per-producer pattern: each component owns its
emitter and callers subscribe directly.

Standalone-typecheck invariant: the entire `main/src/orchestrator/` subtree must compile
without transitive imports from `electron`, `better-sqlite3`, or any service in
`main/src/services/*`. This keeps the orchestrator extractable to a standalone Node process
for the team-tier v2 target (ROADMAP-001 §6.3).

### Services (`main/src/services/`)

Core business logic services. Key components:
- **`cliManagerFactory.ts` / `panels/claude/claudeCodeManager.ts`** — PTY-based Claude Code
  session lifecycle via `@homebridge/node-pty-prebuilt-multiarch`. Inherits `AbstractCliManager`.
- **`simpleTaskQueue.ts`** — In-process concurrency queue (no Redis). Used for session
  mutation serialization.
- **`worktreeManager.ts`** — `git worktree add -b ...` lifecycle; collision-safe naming;
  background cleanup.
- **`permissionIpcServer.ts`** — Unix socket server that bridges `--permission-prompt-tool`
  callbacks; synchronously pauses Claude until the renderer sends an approval decision.
- **`database.ts`** — `better-sqlite3` wrapper, WAL mode, hand-rolled migration runner.
- **`sessionManager.ts`** — Coordinates session state across services.

### IPC Layer (`main/src/ipc/`)

Electron `ipcMain` handlers, one file per domain (`session.ts`, `git.ts`, `panels.ts`, etc.).
Currently raw Electron IPC; the target architecture (per system design §4) is `electron-trpc`
for typed renderer ↔ orchestrator calls. `index.ts` registers all handlers at app start.

#### cyboflow.* transport status

Raw IPC handlers in `main/src/ipc/cyboflow.ts` own the `cyboflow.*` surface today
(`cyboflow:listWorkflows`, `cyboflow:startRun`, `cyboflow:approveRun`, `cyboflow:mcp-health`).
The tRPC routers under `main/src/orchestrator/trpc/routers/` (`runs.ts`, `approvals.ts`,
`workflows.ts`) carry the SHAPE of the v2 contract but every procedure body is a placeholder
— none of those procs is wired to a real implementation. The renderer (`frontend/src/utils/cyboflowApi.ts`)
routes via `electron.invoke`, not via the tRPC client.

The migration from raw IPC to tRPC is owned by a future task (placeholder ID: TBD-tRPC-cutover).
Until that migration lands, the tRPC routers serve as documented type contracts for the
renderer's future tRPC client, not as live transports. Each placeholder proc is annotated
with the raw-IPC equivalent so the migration executor can grep-replace stubs with minimal diff.

### Renderer (`frontend/src/`)

- **`components/panels/`** — Per-panel React components. Panel types: `claude/`, `codex/` (to
  be deleted), `diff/`, `editor/`, `logPanel/`, `ai/` (abstract base).
- **`stores/`** — Zustand slices, one per domain: `sessionStore`, `panelStore`, `configStore`,
  `navigationStore`, `errorStore`, `sessionHistoryStore`, `sessionPreferencesStore`.
- **`utils/api.ts`** — Thin IPC call wrapper used by all frontend components to talk to main.

### Shared Types (`shared/types/`)

`models.ts`, `panels.ts`, `cliPanels.ts`, `aiPanelConfig.ts`. Both packages import from here
via `../../../shared/types/...`. Changing types here is a cross-package concern.

## Frameworks & External Dependencies

- **Electron 37.6.0** — Desktop shell. `electron-builder` for packaging/signing; `@electron/rebuild`
  for native module rebuilds against Electron's Node ABI.
- **React 19 + Vite** — Renderer. Tailwind CSS for styling; `clsx` + `tailwind-merge` via `cn()`.
- **Zustand** — Renderer state. One slice per domain; no Redux.
- **better-sqlite3 11.10.0** — SQLite, synchronous, WAL mode. Database lives at `~/.cyboflow/`.
  (Still named `~/.crystal/` in the fork — to be renamed per system design §3.)
- **@homebridge/node-pty-prebuilt-multiarch 0.12.0** — PTY sessions. Pre-built binaries; rebuilt
  for Electron ABI by `electron-builder install-app-deps` postinstall.
- **@modelcontextprotocol/sdk** — For the SoloFlow MCP server (runs as a stdio subprocess).
- **p-queue** (via `simpleTaskQueue.ts` wrapper) — Per-run mutation serialization.
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

## Build & Run

```
pnpm dev                  # Start Electron dev (frontend Vite dev server + Electron)
pnpm build:mac:arm64      # Full macOS arm64 build → packaged app
pnpm typecheck            # Type-check all workspaces
pnpm lint                 # ESLint across all workspaces
pnpm test                 # Playwright E2E (requires a built app)
```

## Decisions & Trade-offs

See `docs/cyboflow_system_design.md` §2 (stack), §3 (fork rationale, cuts), §4 (principles).
Key standing decisions: macOS-only v1; no Redis; no Codex/OpenAI; deterministic worktree names;
orchestrator self-contained inside Electron main (extractable to Node service for team tier).
