# Code Patterns

Reusable conventions and shared utilities in this codebase. Each entry points
to a canonical example — read those for the actual implementation.

## File / Directory Conventions

- **Naming:** Components: `PascalCase.tsx`. Services/utils/stores: `camelCase.ts`.
  IPC handlers: `camelCase.ts` per domain (e.g. `session.ts`, `git.ts`).
- **Test colocation:** Unit tests live in `__tests__/` subdirectories next to the file
  under test (e.g. `main/src/services/__tests__/gitStatusManager.test.ts`). E2E tests
  are top-level in `tests/`.
- **Shared test fixtures:** Live in sibling `__test_fixtures__/` directories (NOT under
  `__tests__/__fixtures__/`). See `main/src/orchestrator/__test_fixtures__/` for canonical
  examples (`dbAdapter.ts`, `loggerLikeSpy.ts`, and `rawEvents.ts`).
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

### `main/src/orchestrator/loggerAdapter`

- **Path:** `main/src/orchestrator/loggerAdapter.ts`
- **Use it for:** Bridging a `Logger` instance to any boundary typed as `LoggerLike`
  (the structural interface in `main/src/orchestrator/types.ts`). Call
  `makeLoggerLike(logger)` — also handles the `logger === undefined` case by returning
  a console-based shim, so callers never need a null check. Companion `makeDatabaseLike`
  builds the matching `DatabaseLike` adapter.
- **Why single-source:** Hand-rolled inline adapters (`{ info: m => logger.info(m), ... }`)
  silently drift when `Logger` or `LoggerLike` gain methods — FIND-017-5 extracted this
  utility specifically to kill that drift surface, and TASK-651 re-introduced it before
  the code-reviewer caught the duplication. Do NOT inline.
- **Canonical example:** `main/src/services/panels/claude/claudeCodeManager.ts:503`;
  `main/src/index.ts:559` and `:717`.

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

### `frontend/src/trpc/client`

- **Path:** `frontend/src/trpc/client.ts`
- **Use it for:** All tRPC calls from the renderer. Import as `import { trpc } from '<relative>/trpc/client'`.
- **Why single-source:** tRPC v11 subscriptions register IPC listeners per `createTRPCProxyClient` instance — a second instance causes duplicate event delivery.
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

### `main/src/orchestrator/__test_fixtures__/dbAdapter`

- **Path:** `main/src/orchestrator/__test_fixtures__/dbAdapter.ts`
- **Use it for:** Wrapping a `better-sqlite3` `Database` into the `DatabaseLike` (`{ prepare, transaction }`) shape required by orchestrator and tRPC handler tests. Do NOT clone locally — the `: DatabaseLike` return-type annotation is the build-time tripwire that catches future widening of `DatabaseLike`.
- **Canonical example:** `main/src/orchestrator/__tests__/workflowRegistry.test.ts`; recurring drift fixed in FIND-SPRINT-017-11.

### `main/src/orchestrator/__test_fixtures__/loggerLikeSpy`

- **Path:** `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts`
- **Use it for:** A `vi.fn()`-based `LoggerLike` spy for orchestrator, IPC, and pipeline tests. `makeSpyLogger()` returns `LoggerLike & { calls: LogCall[] }` — each method is a Vitest spy and pushes structured entries onto `calls` for log assertions. `makeProdLoggerSpy()` returns a `Pick<Logger, 'warn' | 'info' | 'verbose'>`-shaped spy for service-layer call sites that pass the spy to code expecting the production `Logger` (cast via `as unknown as Logger` at the seam).
- **Why single-source:** TASK-646 consolidated 6+ local `makeLogger()` helpers; a second local factory regressed in the same sprint (FIND-SPRINT-024-10). Do NOT clone locally. If a call site needs a different shape, extend this file with a new factory — do not fork.
- **Canonical example:** `main/src/orchestrator/__tests__/runLauncher.test.ts` (LoggerLike); `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts` (production Logger).

### `main/src/orchestrator/__test_fixtures__/rawEvents`

- **Path:** `main/src/orchestrator/__test_fixtures__/rawEvents.ts`
- **Use it for:** Any test that needs a `raw_events` table — persistence (`bridgeEvents`, `RawEventsSink`), consumption (`runExecutor`), or schema reconciliation. Exports `RAW_EVENTS_DDL`, `makeRawEventsDb()` (in-memory `better-sqlite3` with the table created and FKs off), and `countRawEvents(db, runId)`. Do NOT inline `CREATE TABLE ... raw_events` locally — a migration 006 schema change must propagate via this single source.
- **Why single-source:** TASK-665 extracted this to kill three inline DDL copies; FIND-SPRINT-025-9 caught a fourth (`rawEventsSink.test.ts`) the migration sweep missed. New `raw_events` test sites import here.
- **Canonical example:** `main/src/orchestrator/__tests__/runEventBridge.test.ts`; `main/src/orchestrator/__tests__/runExecutor.test.ts`.

### Database seed helpers

Shared helpers live in `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts`:

- `createTestDb()` — in-memory `better-sqlite3` with the full cyboflow schema
  applied via `GATE_SCHEMA` (column-parity-pinned to `006_cyboflow_schema.sql`
  by `__tests__/orchestratorTestDb.test.ts`).
- `seedRun(db, overrides?)` — inserts a `workflows` + `workflow_runs` pair;
  `overrides` accepts any column subset (e.g. `{ id, status, workflowName }`).
- `seedApproval(db, overrides)` — inserts one `approvals` row; `overrides.runId`
  is required (no phantom FK rows); all other fields are optional with defaults:
  `toolName='bash'`, `toolInputJson='{}'`, `toolUseId={id}`, `status='pending'`,
  `createdAt=now`. Call sites that need SDK-canonical casing pass `toolName:'Bash'`
  explicitly — self-documenting at the call site.

Do NOT inline `INSERT INTO workflow_runs` in new test files — use `seedRun`.
Do NOT inline `INSERT INTO approvals` in new test files — use `seedApproval`.
The caller must have already seeded the parent run via `seedRun` before calling
`seedApproval` — a missing parent row will fail the FK constraint and surface
the bug immediately.

**Canonical examples:** `main/src/orchestrator/__tests__/runRecovery.test.ts`,
`main/src/orchestrator/__tests__/stuckDetector.test.ts`,
`main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts`.

## Recurring Patterns

### Shared types as the cross-package contract

Types in `shared/types/` are imported by both `main/` and `frontend/`. When adding a new
domain concept that spans both, define its type in `shared/types/` first. Never duplicate
type definitions across packages.

- `shared/types/models.ts` — database-layer model types
- `shared/types/panels.ts` — panel configuration and state types
- `shared/types/cliPanels.ts` — CLI-specific panel types

**Stuck-event types** live in `shared/types/stuckDetection.ts` — `StuckDetectedEvent`,
`StuckReason`, and the forward-looking `StuckEventsClient` structural cast shim used
until TASK-254 ships a typed `trpc.cyboflow.events.onStuckDetected` subscription. Rules:

- Import all stuck-event types from `shared/types/stuckDetection.ts`. Do NOT re-declare
  `StuckEventsClient` or `StuckDetectedEvent` locally — SPRINT-023 had two sites do this
  independently, producing a verbatim duplicate interface and a doubled IPC subscription.
- Exactly one App-level mount should cast `trpc.cyboflow.events as unknown as
  StuckEventsClient` and open the subscription. Other consumers read from the Zustand
  `reviewQueueSlice` (`runStatusMap`) instead of opening their own tRPC subscription.
- Audit: `grep -rn 'StuckEventsClient' frontend/src` must return exactly one cast site.

**Label maps for shared-type discriminants** belong next to the type (same file
or a companion `*Labels.ts` in `shared/types/`), keyed by `Record<Union['kind'], string>`
so adding a new variant breaks the map at compile time. Never duplicate the map in a
component and a hook — see `frontend/src/components/ReviewQueue/StuckInspectorModal.tsx`
and `frontend/src/hooks/useStuckNotifications.ts` (SPRINT-013 divergence) for the
anti-pattern.

**Claude stream block types** live in `shared/types/claudeStream.ts` — the single source of
truth for `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`, and the
`ClaudeStreamEvent` discriminated union. Rules:

- Import block types directly from `shared/types/claudeStream.ts`. Do NOT re-declare local
  `interface ToolResult`/`TextBlock`/`ToolUseBlock` shadow types — a shadow that pins
  `ToolResultBlock.content` back to `string` hides the array branch from TypeScript at every
  downstream callsite (FIND-SPRINT-020-9 — both `toolFormatter.ts` files).
- `ToolResultBlock.content` is `string | Array<{type: 'text'; text: string}>`. Always guard:
  `typeof content === 'string' ? content : content.map(b => b.text).join('')`. Never call
  `JSON.parse`, `.includes(...)`, or template-string interpolation on raw `content`.
- The `@deprecated` re-exports in `{frontend,main}/src/types/session.ts` (`TextContent`,
  `ToolUseContent`, `ToolResultContent`) are a temporary migration bridge — do not add new
  consumers.
- TS↔Zod drift bridge: `main/src/services/streamParser/schemas.ts` `_typeCheck` catches
  required-field drift. Optional-field drift is a known gap (SPRINT-020 TASK-571 HUMAN_NEEDED).

**StreamEvent discriminated-union narrowing:** `StreamEvent.type` (`frontend/src/utils/cyboflowApi.ts`)
and `StreamEvent.payload` MUST be narrowed in the same pass. Leaving `payload: unknown`
while `type` is a union forces `as ClaudeStreamEvent`-style casts at every consumer and
defeats the discriminated-union design. If a non-SDK synthetic event exists (e.g. a
bootstrap `run_started` row with no SDK payload), model it as its own union member
(`{ type: 'run_started'; payload?: undefined }`) so `switch (event.type)` stays
exhaustively auto-narrowed. A bare `payload: unknown` on a typed envelope is the
tripwire — grep for it before merging.
Canonical drift: FIND-SPRINT-026-20 — five surviving casts at `RunView.tsx:38,98,138,167,186`.

**StreamEvent must be a derived alias, not a re-declaration.** Express the
renderer type as `StreamEvent = StreamEnvelope & { runId: string }` in
`frontend/src/utils/cyboflowApi.ts` — never re-declare the
`StreamEnvelopePayload` arms locally. A parallel union forces synchronised
edits across `StreamEventType`, `StreamEnvelopePayload`, and the renderer
type; omission silently routes new variants to `UnknownEventRow` instead of
failing typecheck. Canonical drift: FIND-SPRINT-031-4 — resolved as A4 in
the SPRINT-031 compound.

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

**Runtime input validation:** Every handler that reads from `args` MUST validate args via
`validateInput` from `main/src/ipc/validateInput.ts`. A bare `const { projectId } = args as
{ projectId: number }` cast is insufficient — if the renderer passes `undefined`,
better-sqlite3 throws or returns wrong rows silently. Hand-rolled type guards are forbidden
— they fork the error-shape and make the in-progress tRPC ipcLink migration harder.

## IPC handler input validation

All `ipcMain.handle` handlers in `main/src/ipc/*.ts` MUST validate args via
`validateInput` from `main/src/ipc/validateInput.ts`. Hand-rolled type guards
are forbidden — they fork the error-shape and make the in-progress tRPC ipcLink
migration harder.

Canonical usage:

```ts
const v = validateInput(z.object({ projectId: z.number().finite() }), args, 'cyboflow:approveRun');
if (!v.ok) return { success: false, error: v.error };
const { projectId } = v.value;
```

See `main/src/ipc/cyboflow.ts` for the canonical caller.

Canonical drift: FIND-SPRINT-028-11 — three cyboflow:* handlers without guards (resolved by TASK-726 via the `validateInput` helper).

### Per-session mutation serialization

Any state mutation for a workflow run passes through a per-run `SimpleQueue({concurrency: 1})`.
This serializes concurrent events (Claude stream events arriving while user approves a tool call).
Do not skip the queue for "quick" mutations — the queue is the correctness guarantee.

### tRPC seed-query + subscription race policy

For a tRPC pair where a query returns initial state and a subscription delivers
delta events (e.g. `getPhaseState` + `onStepTransition`), the consumer MUST open
the subscription BEFORE awaiting the query — not in a separate concurrent
`useEffect` — so events that arrive during the query window are not overwritten
when the seed resolves. Use a `cancelled` flag so the seed `.then()` skips
applying stale state after teardown.

**Canonical example:** `frontend/src/hooks/useWorkflowPhaseState.ts` (subscribe before the `getPhaseState.query` `.then(...)`; both guarded by a `cancelled` flag).
**Anti-pattern:** pre-retrofit `WorkflowProgressTimeline.tsx` ran two sibling effects;
the query's `setStepStates` overwrote subscription deltas (FIND-SPRINT-040-12).

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

### SQLite migrations: `PRAGMA foreign_keys` must toggle OUTSIDE `db.transaction()`

SQLite silently no-ops `PRAGMA foreign_keys` issued inside a transaction
(https://sqlite.org/pragma.html#pragma_foreign_keys). When a migration needs to
disable FK enforcement to DROP+RENAME a table that has FK children, the pragma
toggle MUST be outside the `db.transaction(...)` wrapper, and the restore MUST
run in a `finally`:

```typescript
// CORRECT — pragma outside the transaction:
db.pragma('foreign_keys = OFF');
try {
  db.transaction(() => {
    db.exec('DROP TABLE workflow_runs');
    db.exec('ALTER TABLE workflow_runs_new RENAME TO workflow_runs');
  })();
} finally {
  db.pragma('foreign_keys = ON');
}

// WRONG — pragma inside the transaction is silently ignored; DROP TABLE then
// CASCADE-deletes every row in every FK child table:
db.transaction(() => {
  db.exec('PRAGMA foreign_keys=OFF; DROP TABLE workflow_runs');
})();
```

Canonical implementation: `main/src/database/database.ts` `runFileBasedMigrations`
(detects `PRAGMA foreign_keys=OFF` in the migration text and hoists the toggle
above its own `this.transaction()` wrapper). Regression test:
`main/src/database/__tests__/fileMigrationRunner.test.ts` `'FK-toggle path: …'`.
TASK-757 added both after a code-reviewer caught that the inside-transaction
variant would have CASCADE-deleted every row in `approvals`, `messages`, and
`raw_events` during migration 010 development.

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

- **Canonical example (Crystal-preserved):** `main/src/services/worktreeManager.ts:502`
  (method-group)
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

### Mock tRPC at the canonical import path

`vi.mock(...)` must target the canonical client (e.g. `'../../trpc/client'`). The global
setup in `frontend/src/test/setup.ts` pre-stubs it; individual specs override with
their own `vi.mock('../…/trpc/client', …)` calls when they need specific behaviour.
Canonical example: `frontend/src/stores/__tests__/reviewQueueStore.test.ts:27`.

### `pnpm test:e2e` MUST keep its sh-wrapper

`package.json`'s `"test:e2e"` script is:

```json
"test:e2e": "sh -c 'while [ \"$1\" = \"--\" ]; do shift; done; playwright test \"$@\"' --"
```

Do NOT simplify to `"test:e2e": "playwright test"`. pnpm injects a literal
`--` separator between the script body and the user's args (so
`pnpm test:e2e -- tests/smoke.spec.ts --list` becomes
`playwright test -- tests/smoke.spec.ts --list`). After `--`, Playwright
treats every remaining argument as a file glob — `--list` becomes a bogus
glob, the runner executes the matching tests, and the verifier's "list
without executing" assertion fails. The wrapper strips leading `--`
separators so Playwright's flag parser sees them as flags.

Same idiom should be used for any future `pnpm` script that wraps a CLI
with its own flag parser (e.g. `vitest`, `cypress`).

### vitest config must wire `setupFiles` and `globals: true`

Both workspace `vitest.config.ts` files set `globals: true` + `setupFiles:
['./src/test/setup.ts']`. Do not flip to `globals: false` — `frontend/src/test/setup.ts`
calls `expect.extend(...)` from `@testing-library/jest-dom` at module load, which throws
`ReferenceError: expect is not defined` under `globals: false` and breaks every spec in
the workspace. When adding a new `vitest.config.ts` in either workspace, mirror the
existing files; before planning a test-wiring task, grep both `@testing-library/jest-dom`
and `test/setup.ts` — do not rely on a `.test.*` glob.

## Database Schema

### Canonical DDL Source

The `workflow_runs` table and other cyboflow-era tables (`workflows`, `approvals`, `raw_events`, `messages`) live in TWO files that MUST stay in sync:

- `main/src/database/schema.sql` — fresh-install fast path. Run once on a new DB.
- `main/src/database/migrations/006_cyboflow_schema.sql` — upgrade path. Applied via `runFileBasedMigrations()` for existing DBs.

**canonical DDL source for cyboflow tables: migration 006.** Treat it as the authoritative declaration; mirror any column add/drop into `schema.sql` in the same commit. Migration 007 (and any future 00N) extends the schema additively.

A CI guard (`pnpm run verify:schema`, wired into `pnpm run test:unit`) opens an in-memory SQLite, applies the two paths side-by-side, and asserts the resulting column sets and FKs match. The script lives at `scripts/verify-schema-parity.js`; it does NOT compare test fixtures like `registrySchema.ts` — those are documented subsets and any drift is caught by the test suites that import them.

## permissionMode contract

**Source of truth:** `shared/types/permissionMode.ts` exports both the type alias and the default constant:

```typescript
export type PermissionMode = 'approve' | 'ignore';
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'approve';
```

**Rules — enforced by grep-gate in TASK-654:**

1. **No UI surface may expose `'ignore'` as selectable.** The Settings.tsx Default Security Mode section and the BaseCliPanel.tsx Permission Mode dropdown must each offer only `value="approve"`. Verification: `grep -rnE 'value="ignore"' frontend/src/ tests/` must return 0 matches.

2. **No default or fallback may resolve to `'ignore'`.** Use `DEFAULT_PERMISSION_MODE` (imported from `shared/types/permissionMode`) wherever a missing value must be filled in. Verification: `grep -rnE "\|\| 'ignore'" main/src/ frontend/src/ shared/` must return 0 matches.

3. **`'ignore'` remains a valid typed value** — it is consumed by `claudeCodeManager.ts:389` (omits the PreToolUse hook for a legitimate debug bypass) and by test fixtures. Do NOT remove `'ignore'` from the `PermissionMode` union or the DB CHECK constraint — legacy rows and the manager's bypass path depend on it.

4. **DB CHECK constraint is `IN ('approve', 'ignore')`** — both values are persisted. Migration 008 (`main/src/database/migrations/008_permission_mode_approve_default.sql`) backfills NULL rows to `'approve'` on legacy installs. The DEFAULT clause on new columns uses `'approve'`.

5. **Import discipline:** Import `DEFAULT_PERMISSION_MODE` and `PermissionMode` from `shared/types/permissionMode.ts`. Do NOT re-declare the type inline or hardcode the string `'approve'` as a standalone fallback literal (`|| 'approve'`). The constant import is the compile-time tripwire that catches regressions — a string literal is invisible to grep-gate sweeps once the surrounding context shifts. Verification: `grep -rnE "\|\| 'approve'" main/src/ frontend/src/ shared/ --include='*.ts' --include='*.tsx'` must return 0 matches in non-comment lines.

`/soloflow:compound` will append patterns extracted from completed sprints to this file over time.
