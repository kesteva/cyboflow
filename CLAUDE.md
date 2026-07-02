# cyboflow

cyboflow is a self-contained Electron desktop app for running AI coding flows in parallel against the same project, isolated via git worktrees. It ships three built-in flows — **Planner**, **Sprint**, and **Compound** — whose prompt bodies live in app source (`main/src/orchestrator/workflows/planner.md` + `sprint.md` + `compound.md`). It is a fork of [Crystal](https://github.com/stravu/crystal) (`stravu/crystal@0.3.5`) currently being narrowed and rebuilt — see `docs/cyboflow_system_design.md` for the target scope and `docs/ARCHITECTURE.md` for the current component layout.

## Entity model + review queue

The DB-canonical backlog is a **3-table entity model** — `ideas` / `epics` / `tasks` (migration 015), each with its own columns + a single markdown `body`, sharing **one 12-stage board** (union view; terminal `Decomposed` stage for retired ideas). A polymorphic `entity_events` log replaces the old task-scoped `task_events`. ALL entity writes funnel through the single chokepoint `TaskChangeRouter.applyChange` (`main/src/orchestrator/taskChangeRouter.ts`) — nothing UPDATEs those tables directly. A unified **`review_items`** inbox (migration 016) backs the review queue (`kind in finding|permission|decision|human_task`, per-item `blocking`, soft polymorphic entity link); all its writes go through `ReviewItemRouter`. The flow agents write the entity model exclusively via the `cyboflow_*` MCP tools — never markdown state files. The built-in flow names are `CYBOFLOW_WORKFLOW_NAMES` (`['planner','sprint','compound']`) in `shared/types/workflows.ts` (type `CyboflowWorkflowName`, guard `isCyboflowWorkflowName`); `compound` was rebuilt natively from the preserved prose (launched from the Insights view), while the dropped `prune` flow keeps its prose under `docs/workflows-future/`. See `docs/ARCHITECTURE.md` "Data Model" and `docs/CODE-PATTERNS.md` for the chokepoint patterns.

## Reference Docs

Load these before doing non-trivial work; they own the details so this file can stay short:

- `docs/ARCHITECTURE.md` — live component breakdown, dependency stack, data model, IPC contract.
- `docs/CODE-PATTERNS.md` — canonical patterns (task queue, shared utilities, `@cyboflow-hidden` template).
- `docs/cyboflow_system_design.md` — product spec, scope decisions, extension points.
- `docs/crystal-legacy/` — historical Crystal docs preserved for reference (CLI tool integration guides, troubleshooting).
- `docs/signing/APPLE_DEVELOPER_SETUP.md` — Apple signing env-var contract and provisioning steps. Load before any build, packaging, or release task.
- `docs/VISUAL-VERIFICATION-SETUP.md` — Electron visual-verification contract (visual_web non-functional; visual_macos via Peekaboo; two macOS permissions).

## `@cyboflow-hidden` Convention

Code that is intentionally unreachable in cyboflow v1 is marked with `@cyboflow-hidden` — either Crystal-baseline code preserved for future re-enablement OR a forward-looking placeholder awaiting a later integration task. Do NOT delete such code; do NOT add the marker to actively-called code. See `docs/CODE-PATTERNS.md` for the annotation template and canonical examples in both categories.

## Preserved Extension Points

`AbstractCliManager` (`main/src/services/panels/cli/AbstractCliManager.ts`) is an intentional extension surface per `docs/cyboflow_system_design.md:64` — do NOT collapse it into its single concrete subclass (`ClaudeCodeManager`). It is designed to host additional CLI tool integrations in future sprints. Contrast with `AbstractAIPanelManager` / `BaseAIPanelHandler`, which ARE collapse candidates (Crystal-era Claude+Codex scaffolding).

### Dual-substrate (IDEA-013) — resolves once, base PTY methods are LIVE

The CLI substrate (`'sdk'` | `'interactive'`) resolves **ONCE** at the `CliManagerFactory` / `SubstrateDispatchFacade` seam (`substrateResolver.ts` → stamped immutably onto `workflow_runs.substrate` by `WorkflowRegistry.createRun`, no UPDATE path) and is threaded per-run via `run.substrate` read by the boot-seam **facade source** (`SubstrateDispatchFacade`, the single `RunExecutor` source + spawner). `AbstractCliManager.spawnPtyProcess` / `setupProcessHandlers` / `killProcessTree` are **LIVE and load-bearing** for the interactive sibling (`interactiveClaudeManager.ts`) — do NOT prune them and do NOT mark them `@cyboflow-hidden` even though the SDK `ClaudeCodeManager` no longer routes through the PTY path. See `docs/ARCHITECTURE.md` "Dual-substrate seam, components, and rollback" for the full seam, the Q3 panel-preservation invariant, and the v1 limits.

## Common Commands

```bash
pnpm dev               # Electron dev (Vite renderer + Electron main)
pnpm build:main        # Compile main process (run at least once before `pnpm dev`)
pnpm typecheck         # Type-check all workspaces
pnpm lint              # Lint all workspaces
pnpm test:e2e          # Playwright E2E (requires display + Electron preload — NOT a code-change AC gate; see below)
pnpm test:unit         # Unit chain — main + frontend vitest, schema parity, build scripts (use this as the verifier AC gate)
pnpm electron:rebuild  # Fix better-sqlite3 NODE_MODULE_VERSION errors after Node/Electron upgrades
pnpm rebuild better-sqlite3   # Targeted reverse fix: `pnpm dev` postinstall rebuilds for Electron ABI (NMV 136); run this before `pnpm --filter main test` to restore host Node ABI (NMV 127)
pnpm test:gate         # Day-gate integration test; requires `claude` on PATH + real API access — manual/unscheduled, not part of test:unit or CI
```

Platform packaging (`pnpm build:mac:arm64`, `pnpm build:mac:universal`, etc.) — see `package.json` `scripts`.

Workspace `"test"` scripts that participate in a root multi-tier chain (e.g. `pnpm run test:unit`) MUST be one-shot — use `"vitest run"`, never bare `"vitest"`. Bare `vitest` defaults to watch mode in a TTY and hangs the chain locally (CI escapes only because stdout is not a TTY). Put watch mode on a separate `"test:watch"` key.

`pnpm test:e2e` now drives the **built Electron bundle** via Playwright's `_electron.launch()` (fixture: `tests/helpers/electronApp.ts`) — it launches `main/dist/main/src/index.js` under `NODE_ENV=production` against a throwaway `--cyboflow-dir` tmp data dir and attaches to the real Electron window (no Vite dev server, no `http://localhost:4521`, no `webServer`). The `pretest:e2e` hook builds the prereqs (`build:main` + `build:frontend` + `electron:rebuild`) — the launched app needs better-sqlite3 on the **Electron** ABI, so after an e2e run you MUST `pnpm rebuild better-sqlite3` to restore the host-Node ABI before running vitest. Two tiers: `playwright.config.ts` (full, `workers:1`, all specs) and `playwright.ci.minimal.config.ts` (smoke: health-check + smoke + Settings). Seeded specs (`cyboflow-picker`, `standalone-terminal-panels`) boot once to create the DB, then `seedProject()` inserts a project row via the `/usr/bin/sqlite3` CLI (better-sqlite3 can't be imported host-side post-rebuild). It is still **NOT the headless code-change AC gate**: it needs a real display (Electron windows appear on screen) and `visual_web`/Playwright-MCP remain non-functional for the same preload reason. Verifiers MUST use `pnpm test:unit` as the AC gate; run e2e locally on macOS or via the report-only nightly `.github/workflows/e2e.yml` (macOS runner), which flips to blocking once green two consecutive runs.

Visual verification of any frontend UI change requires `pnpm dev` (full Electron). The Vite renderer at `http://localhost:4521` cannot bootstrap standalone — it depends on `preload`-injected `electronTRPC` and will error without the main process. For headless validation when capture is unavailable, read `cyboflow-frontend-debug.log` (see below).

The `visual_web` / Playwright MCP path is NON-FUNCTIONAL here (renderer cannot bootstrap without Electron `preload`). Use `visual_macos` via Peekaboo MCP with `pnpm dev` running. Both Screen Recording AND Accessibility grants must be held by the **MCP host process binary** (not only Cyboflow.app or Warp) — if `mcp__peekaboo__image` reports declined TCCs while `server_status` shows grants present, run the TCC.db host-process diagnostic in `docs/VISUAL-VERIFICATION-SETUP.md` (recurring failure across SPRINT-031..SPRINT-039).

## Frontend/Backend Debug Logs (dev mode)

In `pnpm dev`, the app writes `cyboflow-frontend-debug.log` and `cyboflow-backend-debug.log` to the project root. Both are truncated on each dev launch, so they reflect only the most recent user session. Read these (preferably from a sub-agent) instead of asking the user to paste console output. Production builds do not write these files.

## TypeScript Rules

The `any` type is forbidden. ESLint rule `@typescript-eslint/no-explicit-any` is set to `error` and CI enforces it. Use `unknown` (with type guards) or narrow generics instead.

**IPC / type-parity rules (silent-drop class).** A type declaration that drifts from the runtime shape across an IPC/tRPC boundary silently drops fields instead of failing the build. The rules — each with its case study, audit grep, and rationale — live in `docs/CODE-PATTERNS.md` → "IPC / type-parity rules (silent-drop class)". In brief:

- `IPCResponse<T>` callers MUST pass an explicit `T` (the wrapper defaults `T = unknown`); never declare a local `IPCResponse`/`{ success; data?; error? }` shape — import from `frontend/src/utils/api.ts`.
- A handler's declared `T` MUST match what it returns at runtime, and request interfaces (e.g. `CreateSessionRequest`) MUST stay in sync frontend↔main. On any IPC touch, grep the channel/interface name across both sides in the same pass; prefer promoting to `shared/types/ipc.ts`.
- Pass `logger?` into observability classes (`TypedEventNarrowing`, `RawEventsSink`, `MessageProjection`) — omitting it no-ops all diagnostics.
- tRPC subscription `onData` payload types MUST come from `AppRouter` inference — never a local mirror or `(evt: unknown)` + runtime guard.

## localStorage Key Migrations

Use `frontend/src/utils/migrateLocalStorageKey.ts` for any localStorage key rename — never write ad-hoc `getItem`/`setItem` rename logic. See `docs/CODE-PATTERNS.md` for the mount-only call contract and the `console.ts` anti-pattern.
