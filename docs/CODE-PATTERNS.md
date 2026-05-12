# Code Patterns

Reusable conventions and shared utilities in this codebase. Each entry points
to a canonical example — read those for the actual implementation.

## File / Directory Conventions

- **Naming:** Components: `PascalCase.tsx`. Services/utils/stores: `camelCase.ts`.
  IPC handlers: `camelCase.ts` per domain (e.g. `session.ts`, `git.ts`).
- **Test colocation:** Unit tests live in `__tests__/` subdirectories next to the file
  under test (e.g. `main/src/services/__tests__/gitStatusManager.test.ts`). E2E tests
  are top-level in `tests/`.
- **Barrels:** No barrel `index.ts` re-exports used; import paths are explicit.
- **Formatting:** No Prettier config. ESLint with TypeScript rules in each workspace
  (`frontend/eslint.config.js`, `main/eslint.config.js`). Run via `pnpm lint`.
- **Backup files:** Upstream codebase contains `.backup` files (e.g. `ClaudePanel.tsx.backup`).
  Delete these when touching the surrounding file.

## Shared Utilities

### `frontend/src/utils/cn`

- **Path:** `frontend/src/utils/cn.ts`
- **Use it for:** Merging Tailwind class names conditionally. Wraps `clsx` + `tailwind-merge`.
- **Canonical example:** Any component in `frontend/src/components/ui/`

### `main/src/utils/mutex`

- **Path:** `main/src/utils/mutex.ts`
- **Use it for:** Per-resource async locking to prevent races in the orchestrator.
  Call `mutex.acquire(resourceName)` — returns a release function.
- **Canonical example:** `main/src/services/sessionManager.ts`

### `main/src/services/simpleTaskQueue`

- **Path:** `main/src/services/simpleTaskQueue.ts`
- **Use it for:** In-process job queue with concurrency limits. No Redis.
  Construct with `new SimpleQueue(name, concurrency)`, call `.process(n, handler)`, then `.add(data)`.
- **Canonical example:** `main/src/services/cliManagerFactory.ts`

### `main/src/utils/logger`

- **Path:** `main/src/utils/logger.ts`
- **Use it for:** Structured file logging in the main process. Rolling 10 MB logs, max 5 files.
  Captures original `console.*` methods before any override to avoid recursion.
- **Canonical example:** `main/src/services/sessionManager.ts`

### `frontend/src/utils/api`

- **Path:** `frontend/src/utils/api.ts`
- **Use it for:** All IPC calls from renderer to main. Do not call `window.electron` directly
  from components — go through this module.
- **Canonical example:** Any store in `frontend/src/stores/`

### `frontend/src/utils/migrateLocalStorageKey`

- **Path:** `frontend/src/utils/migrateLocalStorageKey.ts`
- **Use it for:** One-shot localStorage key rename (e.g. crystal-→cyboflow-). Reads legacy key,
  copies value to new key, deletes legacy key, returns value. Idempotent.
- **Call contract:** Invoke inside `useEffect(..., [])` or a `useState(() => ...)` initializer —
  never inside a closure that runs on every render or log call.
- **Canonical example:** `frontend/src/App.tsx:60` (mount-time call).
- **Anti-pattern:** `frontend/src/utils/console.ts:9–12` calls it inside `isVerboseEnabled()`,
  which fires on every `devLog.*` invocation — redundant localStorage reads per log line.

## Recurring Patterns

### Shared types as the cross-package contract

Types in `shared/types/` are imported by both `main/` and `frontend/`. When adding a new
domain concept that spans both, define its type in `shared/types/` first. Never duplicate
type definitions across packages.

- `shared/types/models.ts` — database-layer model types
- `shared/types/panels.ts` — panel configuration and state types
- `shared/types/cliPanels.ts` — CLI-specific panel types

### Zustand store structure (renderer)

One store file per domain in `frontend/src/stores/`. Each store uses Zustand's `create` with
a typed slice. Components subscribe to specific slices to avoid unnecessary re-renders.
Stores never write to the database or call Node APIs — those go through `utils/api.ts`.

- **Canonical example:** `frontend/src/stores/sessionStore.ts`

### IPC handler structure (main process)

Each domain has its own IPC file in `main/src/ipc/` that registers `ipcMain.handle` calls.
All handlers are registered in `main/src/ipc/index.ts`. Keep business logic in `services/`,
not in IPC handlers — handlers should be thin: validate input, delegate to service, return result.

- **Canonical example:** `main/src/ipc/session.ts`

### Per-session mutation serialization

Any state mutation for a workflow run passes through a per-run `SimpleQueue({concurrency: 1})`.
This serializes concurrent events (Claude stream events arriving while user approves a tool call).
Do not skip the queue for "quick" mutations — the queue is the correctness guarantee.

### Database access

`main/src/services/database.ts` is the singleton. All mutations go through the main process —
the renderer never accesses SQLite directly. SQL is hand-written (no ORM); use parameterized
queries. Migrations are plain `.sql` files in `main/src/database/migrations/`, named to sort
in application order.

### `@cyboflow-hidden` annotation

Mark preserved-but-disconnected code (kept for future re-enablement) at the top of the file
(whole-component case) or immediately above the first function of the disconnected group
(partial-file case). Always include a one-sentence re-enable hint pointing at the call site
to restore.

```
// @cyboflow-hidden: <what is unreachable> in cyboflow v1.
// Re-enable by <restoring specific call site or JSX usage>.
```

- **Canonical examples:** `main/src/services/worktreeManager.ts:472` (method-group),
  `frontend/src/components/SessionView.tsx:14` (import-line)
- **Audit tool:** `grep -rn '@cyboflow-hidden' main/src frontend/src` lists all
  preserved-but-inactive surfaces.

## Build & Packaging

### macOS signing posture (`scripts/configure-build.js`)

`scripts/configure-build.js` runs as a `prebuild:mac*` / `prerelease:mac` step and is the
**single canonical writer** of `build.mac.notarize`, `hardenedRuntime`, and `gatekeeperAssess`.
Do not edit these keys directly in `package.json` — `configure-build.js` overwrites them on
every build. Decision is driven by env vars (`CSC_LINK`, `APPLE_ID`, `APPLE_TEAM_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `CSC_KEY_PASSWORD`, `CSC_DISABLE`).

- **Canonical example:** `scripts/configure-build.js`, `scripts/configure-build.test.js`
- **Env-var contract:** see `docs/signing/APPLE_DEVELOPER_SETUP.md`.

`/soloflow:compound` will append patterns extracted from completed sprints to this file over time.
