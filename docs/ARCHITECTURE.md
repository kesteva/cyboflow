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
- **`scripts/`** — Build tooling: `inject-build-info.js`, `configure-build.js`, `generate-notices.js`.
- **`build/`** — Electron Builder config files: `afterSign.js`, `entitlements.mac.plist`.

## Major Components / Layers

### Orchestrator (`main/src/services/`)

Core business logic. Key services:
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
- **React 18 + Vite** — Renderer. Tailwind CSS for styling; `clsx` + `tailwind-merge` via `cn()`.
- **Zustand** — Renderer state. One slice per domain; no Redux.
- **better-sqlite3 11.10.0** — SQLite, synchronous, WAL mode. Database lives at `~/.cyboflow/`.
  (Still named `~/.crystal/` in the fork — to be renamed per system design §3.)
- **@homebridge/node-pty-prebuilt-multiarch 0.12.0** — PTY sessions. Pre-built binaries; rebuilt
  for Electron ABI by `electron-builder install-app-deps` postinstall.
- **@modelcontextprotocol/sdk** — For the SoloFlow MCP server (runs as a stdio subprocess).
- **p-queue** (via `simpleTaskQueue.ts` wrapper) — Per-run mutation serialization.
- **Playwright** — E2E tests only.

## Data Model

Schema in `main/src/database/schema.sql`; incremental migrations in
`main/src/database/migrations/` (plain SQL files, applied in filename order by the migration runner).
Central tables: `sessions`, `panels`, `execution_diffs`, `projects`. The target Cyboflow schema
adds `workflow_runs`, `raw_events`, `approvals` — designed in system design §5.

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
