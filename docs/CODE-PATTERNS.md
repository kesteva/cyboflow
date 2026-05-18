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
- **Exception — `frontend/src/utils/cyboflowApi.ts`:** temporary parallel surface for the
  cyboflow workflow domain pending the epic-6 transport decision (raw IPC vs tRPC). Do NOT
  add new channels here, do NOT copy this module pattern into other domains, and do NOT
  deepen its surface — extend `api.ts` (`API.cyboflow.*`) or wait for the tRPC routers.
  Once epic 6 lands, `cyboflowApi.ts` is deleted or replaced by a tRPC client wrapper.

### `frontend/src/utils/trpcClient`

- **Path:** `frontend/src/utils/trpcClient.ts`
- **Use it for:** All tRPC calls from the renderer. Import as `import { trpc } from '<relative>/utils/trpcClient'`.
- **Why single-source:** tRPC v11 subscriptions register IPC listeners per `createTRPCProxyClient` instance — a second instance (or re-export shim) causes duplicate event delivery.
- **Canonical example:** `frontend/src/stores/reviewQueueStore.ts`

### `frontend/src/utils/migrateLocalStorageKey`

- **Path:** `frontend/src/utils/migrateLocalStorageKey.ts`
- **Use it for:** One-shot localStorage key rename (e.g. crystal-→cyboflow-). Reads legacy key,
  copies value to new key, deletes legacy key, returns value. Idempotent.
- **Call contract:** Invoke inside `useEffect(..., [])` or a `useState(() => ...)` initializer —
  never inside a closure that runs on every render or log call.
- **Canonical example:** `frontend/src/App.tsx:60` (mount-time call).
- **Anti-pattern:** `frontend/src/utils/console.ts:9–12` calls it inside `isVerboseEnabled()`,
  which fires on every `devLog.*` invocation — redundant localStorage reads per log line.

### `main/src/utils/commitFooter`

- **Path:** `main/src/utils/commitFooter.ts`
- **Use it for:** The canonical Cyboflow commit-footer string. Single source of truth — never inline the footer literal elsewhere.
- **Key export:** `buildCommitFooter(enabled: boolean): string` (empty string when disabled).
- **Canonical example:** `main/src/utils/shellEscape.ts` (`buildGitCommitCommand`); byte-level contract pinned in `main/src/utils/commitFooter.test.ts`.

### `main/src/utils/devDebugLog`

- **Path:** `main/src/utils/devDebugLog.ts`
- **Use it for:** Writing structured lines to `cyboflow-{frontend,backend}-debug.log` in dev mode. Centralizes the filename literals and line format — do NOT hardcode either elsewhere.
- **Key exports:** `getDevDebugLogPath(stream)`, `appendDevDebugLog(stream, level, source, message, originalConsole?)`. Pass the pre-override `originalConsole.error` from inside `console.*` overrides to avoid recursion.
- **Canonical example:** `main/src/index.ts` console-wrapper overrides and frontend webContents listener.

## Recurring Patterns

### Shared types as the cross-package contract

Types in `shared/types/` are imported by both `main/` and `frontend/`. When adding a new
domain concept that spans both, define its type in `shared/types/` first. Never duplicate
type definitions across packages.

- `shared/types/models.ts` — database-layer model types
- `shared/types/panels.ts` — panel configuration and state types
- `shared/types/cliPanels.ts` — CLI-specific panel types

**Label maps for shared-type discriminants** belong next to the type (same file
or a companion `*Labels.ts` in `shared/types/`), keyed by `Record<Union['kind'], string>`
so adding a new variant breaks the map at compile time. Never duplicate the map in a
component and a hook — see `frontend/src/components/ReviewQueue/StuckInspectorModal.tsx`
and `frontend/src/hooks/useStuckNotifications.ts` (SPRINT-013 divergence) for the
anti-pattern.

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

### Schema reconciliation

When modifying DDL for a table, run TWO greps and cover every match in `files_owned`
(or document exclusions in `plan_decisions`):

1. Inline-DDL consumers: `grep -rn 'CREATE TABLE.*<table>' main/src/ frontend/src/`
2. Migration-file loaders: `grep -rn 'readFileSync.*<NNN>\|join.*migrations.*<NNN>' main/src/`

Verify the column block with full `diff`, never `grep -A N` (the count is fragile and
silently truncates). `schema.sql` (fresh install) and the highest-numbered migration
(upgrade path) must be bidirectionally equivalent — every migration `CREATE TABLE IF NOT
EXISTS` must be a no-op after `schema.sql` runs. When adding a column to a shipped
migration, also search every test file's INSERT/SELECT for the old column list — missing
columns surface as runtime `undefined`, not typecheck errors.

### Extract-shared-utility refactors: prove completeness

Any task that extracts a shared fixture, helper, type, or constant MUST grep the
PRE-refactor pattern across the entire codebase (`main/src/ frontend/src/`) — not just
the files already in the planner's sample. Every match that is a direct substitute for
the new utility appears in `files_owned`; intentional exclusions (different shape,
deferred epic, manual lifecycle) get a one-sentence note in `plan_decisions`. A plan that
lists some but not all matches without exclusion notes leaves the codebase half-migrated.
Recent regressions: TASK-603 (2 inline DDL sites), TASK-604 (5 inline `dbAdapter` copies),
TASK-605 (2 `mkdtempSync` leaks) all shipped with the same root cause.

### `@cyboflow-hidden` annotation

Mark intentionally-unreachable code at the top of the file (whole-component case) or
immediately above the first function of the disconnected group (partial-file case).
Always include a one-sentence re-enable hint pointing at the call site (or upstream
caller / epic for forward-looking placeholders) to restore.

Two valid categories:
1. **Crystal-preserved** — code kept from the `stravu/crystal` baseline, disabled in v1.
2. **Forward-looking placeholder** — fresh cyboflow code unwired until a later sprint's
   integration task lands (e.g. satisfies a grep gate for a Day-N epic).

```
// @cyboflow-hidden: <what is unreachable> in cyboflow v1.
// Re-enable by <restoring specific call site or JSX usage>.
```

- **Canonical examples (Crystal-preserved):** `main/src/services/worktreeManager.ts:472`
  (method-group), `frontend/src/components/SessionView.tsx:14` (import-line)
- **Canonical example (forward-looking placeholder):**
  `main/src/services/panels/claude/claudeCodeManager.ts` — `tryTransitionToAwaitingReview`
  (Day-3 ApprovalRouter integration point)
- **Audit tool:** `grep -rn '@cyboflow-hidden' main/src frontend/src` lists all
  inactive surfaces (both categories).

### IPC preference-backed component visibility

When a component's visibility depends on an async IPC preference (`preferences:get`),
track the read result as `boolean | null` in the parent and render nothing while it is
`null`. Do NOT initialise the child's own state to "hidden by default" and rely on an
async effect to flip it — that produces the correct steady state but a one-frame flash
on every page reload for returning users. Consumers: `OnboardingCard`, `Welcome`,
`DiscordPopup`, `AnalyticsConsentDialog` (audit via `grep -rln 'preferences:get' frontend/src`).

## Build & Packaging

### macOS signing posture (`scripts/configure-build.js`)

`scripts/configure-build.js` runs as a `prebuild:mac*` / `prerelease:mac` step and is the
**single canonical writer** of `build.mac.notarize`, `hardenedRuntime`, and `gatekeeperAssess`.
Do not edit these keys directly in `package.json` — `configure-build.js` overwrites them on
every build. Decision is driven by env vars (`CSC_LINK`, `APPLE_ID`, `APPLE_TEAM_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `CSC_KEY_PASSWORD`, `CSC_DISABLE`).

- **Canonical example:** `scripts/configure-build.js`, `scripts/configure-build.test.js`
- **Env-var contract:** see `docs/signing/APPLE_DEVELOPER_SETUP.md`.

## Frontend Test Conventions

### `afterEach(cleanup)` is mandatory in vitest setup

`frontend/src/test/setup.ts` explicitly registers `afterEach(() => cleanup())`. The
vitest `globals: true` + `@testing-library/react@^16` combo does NOT auto-register
cleanup — without it, `renderHook` calls that attach `window`/`document` listeners
accumulate across tests (test N fires N handlers per key press). Do NOT remove that
line. Hooks with global listeners should include a multi-render regression test —
see `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts`.

### Mock tRPC at the SUT's own import path

`vi.mock(...)` must use the exact specifier the SUT imports (e.g. `'../../utils/trpcClient'`),
not the canonical client file it re-exports from. Mocking the re-export target works only
by accident of ESM hoisting and breaks silently if the shim direction is ever flipped.
Canonical example: `frontend/src/stores/__tests__/reviewQueueStore.test.ts:22`.

### vitest config must wire `setupFiles` and `globals: true`

Both workspace `vitest.config.ts` files set `globals: true` + `setupFiles:
['./src/test/setup.ts']`. Do not flip to `globals: false` — `frontend/src/test/setup.ts`
calls `expect.extend(...)` from `@testing-library/jest-dom` at module load, which throws
`ReferenceError: expect is not defined` under `globals: false` and breaks every spec in
the workspace. When adding a new `vitest.config.ts` in either workspace, mirror the
existing files; before planning a test-wiring task, grep both `@testing-library/jest-dom`
and `test/setup.ts` — do not rely on a `.test.*` glob.

`/soloflow:compound` will append patterns extracted from completed sprints to this file over time.
