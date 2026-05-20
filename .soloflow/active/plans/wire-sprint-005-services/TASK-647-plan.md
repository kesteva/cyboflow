---
id: TASK-647
idea: SPRINT-007-compound
status: in-flight
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/cliManagerFactory.ts
  - main/src/index.ts
  - main/src/ipc/claudePanel.ts
  - main/src/services/__tests__/claudeCodeManagerWiring.test.ts
  - main/src/services/__tests__/claudeCodeManagerPermissions.test.ts
files_readonly:
  - main/src/services/cliToolRegistry.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/panels/claude/claudePanelManager.ts
  - main/src/services/database.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/index.ts
  - .soloflow/active/compound/SPRINT-007-proposal.md
  - .soloflow/archive/done/wire-sprint-005-services/TASK-572-done.md
acceptance_criteria:
  - criterion: ClaudeCodeManager has no static sharedDb field and no setSharedDb method
    verification: "grep -nE 'static (sharedDb|setSharedDb)' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches"
  - criterion: ClaudeCodeManager constructor accepts a non-optional db parameter of type Database.Database (no null) — missing/undefined db is a TypeScript-level error
    verification: "grep -nE 'constructor\\([\\s\\S]*?db:\\s*Database\\.Database[\\s,)]' main/src/services/panels/claude/claudeCodeManager.ts returns at least 1 match AND grep -nE 'db:\\s*Database\\.Database\\s*\\|\\s*null' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches"
  - criterion: RawEventsSink is always created in setupProcessHandlers — no null branch — because db is guaranteed by the constructor
    verification: "grep -nE 'sink\\s*=\\s*null|sink:\\s*RawEventsSink\\s*\\|\\s*null' main/src/services/panels/claude/claudeCodeManager.ts returns 0 matches AND grep -nE 'new RawEventsSink\\(' main/src/services/panels/claude/claudeCodeManager.ts returns at least 1 match"
  - criterion: claudePanel.ts no longer calls setSharedDb
    verification: "grep -n 'setSharedDb' main/src/ipc/claudePanel.ts returns 0 matches"
  - criterion: cliManagerFactory.ts threads a db handle through the claude manager factory function
    verification: "grep -nE 'new ClaudeCodeManager\\([\\s\\S]*?db[\\s,)]' main/src/services/cliManagerFactory.ts returns at least 1 match"
  - criterion: main/src/index.ts passes databaseService.getDb() through additionalOptions when creating the default Claude manager
    verification: "grep -nE 'additionalOptions:\\s*\\{[^}]*db' main/src/index.ts returns at least 1 match"
  - criterion: The wiring test constructs ClaudeCodeManager with a real in-memory db argument and no longer calls setSharedDb
    verification: "grep -n 'setSharedDb' main/src/services/__tests__/claudeCodeManagerWiring.test.ts returns 0 matches AND grep -nE 'new TestableClaudeCodeManager\\([\\s\\S]*?db' main/src/services/__tests__/claudeCodeManagerWiring.test.ts returns at least 1 match"
  - criterion: A new test asserts that constructing ClaudeCodeManager with an undefined db throws an explicit TypeError (not a silent no-op)
    verification: "grep -nE 'requires a db|db argument is required|db is required' main/src/services/__tests__/claudeCodeManagerWiring.test.ts returns at least 1 match"
  - criterion: claudeCodeManagerPermissions.test.ts builds with the new constructor shape (passes db as 5th arg)
    verification: "grep -cE 'new TestableClaudeCodeManager\\(' main/src/services/__tests__/claudeCodeManagerPermissions.test.ts returns 4 AND grep -nE 'new Database\\(.:memory:.\\)' main/src/services/__tests__/claudeCodeManagerPermissions.test.ts returns at least 1 match"
  - criterion: pnpm --filter main typecheck exits 0
    verification: pnpm --filter main typecheck
  - criterion: pnpm --filter main lint exits 0
    verification: pnpm --filter main lint
  - criterion: All ClaudeCodeManager tests pass (wiring + permissions)
    verification: pnpm --filter main test -- claudeCodeManagerWiring claudeCodeManagerPermissions exits 0 with all tests green
depends_on: []
estimated_complexity: medium
epic: wire-sprint-005-services
test_strategy:
  needed: true
  justification: This task removes the silent-no-op degraded mode and replaces it with a constructor invariant. The existing wiring test exercises the static-injector path (degraded mode test at line 276 and afterEach reset at line 184) which becomes invalid; the test must be rewritten to assert the new invariant (missing db = explicit error) and to pass the db as a constructor argument. The permissions test does not touch RawEventsSink behaviour but its constructor calls must be updated to match the new signature.
  targets:
    - behavior: "Constructor with valid db: RawEventsSink is created and raw_events rows are written (the previous AC-1 / AC-2 scenarios, restated against the new constructor shape)"
      test_file: main/src/services/__tests__/claudeCodeManagerWiring.test.ts
      type: integration
    - behavior: "Constructor with undefined or null db: throws a TypeError naming 'db'; the existing AC-5 'degraded mode' test is replaced by this assertion"
      test_file: main/src/services/__tests__/claudeCodeManagerWiring.test.ts
      type: unit
    - behavior: Permissions test continues to pass with new constructor signature (no behavioural change — just signature update)
      test_file: main/src/services/__tests__/claudeCodeManagerPermissions.test.ts
      type: unit
prerequisites:
  - check: "grep -q 'export class AbstractAIPanelManager' main/src/services/panels/ai/AbstractAIPanelManager.ts 2>/dev/null && echo 'collapse-pending'; true"
    fix: "No fix required — this task does NOT depend on the AbstractAIPanelManager collapse. The FIND-SPRINT-007-7 cautionary note suggested gating on the collapse, but the ripple analysis shows the new db constructor parameter flows only through ClaudeCodeManager → cliManagerFactory.ts → index.ts. Neither AbstractAIPanelManager nor BaseAIPanelHandler are in that path. This check is informational only."
    description: "Informational: the original FIND framed this work as contingent on the AbstractAIPanelManager collapse. Ripple inspection (main/src/index.ts:595, cliManagerFactory.ts:170, claudePanelManager.ts:14) confirms the inheritance chain is not touched."
    blocking: false
---
# Replace static sharedDb injector in ClaudeCodeManager with constructor DI

## Objective

`ClaudeCodeManager.sharedDb` is a static singleton injector accepted as a fallback during TASK-572 to avoid touching the constructor surface. It has three known downsides documented at `claudeCodeManager.ts:62-76`: (a) cross-instance state leak in tests requires explicit afterEach reset (`claudeCodeManagerWiring.test.ts:184`), (b) the null branch silently degrades `RawEventsSink` to a no-op which could hide a wiring regression on a future entry path, and (c) it diverges from the constructor-DI pattern every other service in `main/src/services/` uses. This task threads `db: Database.Database` as a constructor parameter, removes the static field + setter + degraded mode entirely, and makes "no db wired" an explicit error rather than a silent no-op. Inspection of the construction graph confirms the ripple is contained: `ClaudeCodeManager` is instantiated exactly once via `cliManagerFactory.ts:180`, called from `main/src/index.ts:595` where `databaseService` is already in scope (initialized at line 549).

## Implementation Steps

1. **Pre-flight grep** — re-confirm the call-site map before editing. Run:
   ```bash
   grep -rn 'setSharedDb\|ClaudeCodeManager\.sharedDb\|new ClaudeCodeManager\(' main/src
   ```
   Expected matches:
   - `main/src/services/panels/claude/claudeCodeManager.ts:64,68,74,75,310,387` (static field, setter, two readers)
   - `main/src/ipc/claudePanel.ts:260` (the only production caller of `setSharedDb`)
   - `main/src/services/cliManagerFactory.ts:180` (the only `new ClaudeCodeManager(...)` site)
   - `main/src/services/__tests__/claudeCodeManagerWiring.test.ts:172, 184, 279, 297` (test calls)
   - `main/src/services/__tests__/claudeCodeManagerPermissions.test.ts:63, 82, 100, 119` (test constructions, do NOT call setSharedDb)
   If grep finds matches outside this set, **stop** and reconcile — there is an unexpected caller.

2. **Update `claudeCodeManager.ts` constructor signature.** Replace the static field, setter, and two readers with a private `db` instance field:
   ```ts
   // Remove lines 62-76 entirely:
   //   - the JSDoc + private static sharedDb declaration
   //   - the static setSharedDb method

   // Update the constructor (current line 81):
   constructor(
     sessionManager: import('../../sessionManager').SessionManager,
     logger: Logger | undefined,
     configManager: ConfigManager | undefined,
     permissionIpcPath: string | null,
     private readonly db: Database.Database,
   ) {
     super(sessionManager, logger, configManager);
     if (db == null) {
       throw new TypeError('[ClaudeCodeManager] db argument is required; RawEventsSink cannot operate without a database handle.');
     }
   }
   ```
   Notes:
   - `db` is the **5th positional argument**, after `permissionIpcPath`. Positional keeps the diff minimal — there is no other constructor-options object in this class.
   - The runtime null/undefined check exists for the `as unknown as Database.Database` test-cast escape hatch; TypeScript already rejects `undefined`, but the runtime guard makes the failure mode explicit.
   - The `Database` import (line 6) is already present — no new import needed.

3. **Replace the two `ClaudeCodeManager.sharedDb` readers.**
   - Line 310 (inside `setupProcessHandlers`):
     ```ts
     // BEFORE:
     const db = ClaudeCodeManager.sharedDb;
     const sink = db ? new RawEventsSink(db, this.logger) : null;
     if (sink) {
       sink.attachToRouter(router, runId);
     }
     // AFTER:
     const sink = new RawEventsSink(this.db, this.logger);
     sink.attachToRouter(router, runId);
     ```
   - Update the `PipelineTuple` interface (line 49-55) to remove the `| null` from `sink`:
     ```ts
     interface PipelineTuple {
       parser: ClaudeStreamParser;
       router: EventRouter;
       sink: RawEventsSink;  // no longer nullable
       detector: CompletionDetector;
       runId: string;
     }
     ```
   - Update `cleanupPipeline` (line 362-369): the `pl.sink?.dispose(pl.runId)` becomes `pl.sink.dispose(pl.runId)`.
   - Line 387 (inside `tryTransitionToAwaitingReview`): replace `const db = ClaudeCodeManager.sharedDb;` with `const db = this.db;` and drop the `if (!db) return;` line (the constructor invariant guarantees it).

4. **Update `cliManagerFactory.ts:170-186`** — thread the `db` handle through the manager-factory closure:
   ```ts
   private registerClaudeTool(): void {
     const claudeManagerFactory: ManagerFactoryFunction = (
       sessionManager: unknown,
       logger?: Logger,
       configManager?: ConfigManager,
       additionalOptions?: unknown,
     ) => {
       const options = additionalOptions as Record<string, unknown> | undefined;
       const permissionIpcPath = options?.permissionIpcPath || null;
       const db = options?.db as import('better-sqlite3').Database | undefined;
       if (!db) {
         throw new TypeError('[CliManagerFactory] claude tool requires `db` in additionalOptions');
       }
       return new ClaudeCodeManager(
         sessionManager as SessionManager,
         logger,
         configManager,
         (typeof permissionIpcPath === 'string' ? permissionIpcPath : null),
         db,
       );
     };
     // ... rest unchanged
   }
   ```
   The `import('better-sqlite3').Database` inline import avoids touching the imports block.

5. **Update `main/src/index.ts:595-601`** — pass `db` through `additionalOptions`:
   ```ts
   defaultCliManager = await cliManagerFactory.createManager('claude', {
     sessionManager,
     logger,
     configManager,
     additionalOptions: {
       permissionIpcPath,
       db: databaseService.getDb(),
     },
     skipValidation: true,
   });
   ```
   `databaseService.getDb()` is safe to call here because `databaseService.initialize()` ran at line 549, well before this point.

6. **Remove `ClaudeCodeManager.setSharedDb` call from `main/src/ipc/claudePanel.ts:256-261`.** Replace the function body:
   ```ts
   // BEFORE:
   export function registerClaudePanelHandlers(ipcMain: IpcMain, services: AppServices): void {
     // Wire the shared DB handle into ClaudeCodeManager so RawEventsSink can persist events.
     // databaseService.getDb() is safe here: DatabaseService.initialize() is called before
     // registerClaudePanelHandlers() in main/src/index.ts.
     ClaudeCodeManager.setSharedDb(services.databaseService.getDb());

     const handler = new ClaudePanelHandler(ipcMain, services, {
   // AFTER:
   export function registerClaudePanelHandlers(ipcMain: IpcMain, services: AppServices): void {
     // DB injection now happens at construction time via cliManagerFactory.createManager()
     // in main/src/index.ts (additionalOptions.db). No setter call required here.
     const handler = new ClaudePanelHandler(ipcMain, services, {
   ```
   Also remove the now-unused `ClaudeCodeManager` import at line 5 of `claudePanel.ts` (it's only used for `setSharedDb`).

7. **Update `claudeCodeManagerWiring.test.ts`** to use the new constructor shape:
   - Delete the `beforeEach` call to `ClaudeCodeManager.setSharedDb(db)` (line 172).
   - Delete the `afterEach` call to `ClaudeCodeManager.setSharedDb(null)` (line 184).
   - Pass `db` as the 5th positional arg to `new TestableClaudeCodeManager(...)` at line 174:
     ```ts
     manager = new TestableClaudeCodeManager(
       makeMinimalSessionManager(),
       undefined,
       makeConfigManager(),
       '/tmp/test.sock',
       db,
     );
     ```
   - **Replace AC-5 (lines 276-298) — "degraded mode" — with a new test** asserting the constructor throws on missing db:
     ```ts
     it('constructor throws TypeError when db is undefined (no silent degraded mode)', () => {
       expect(() => {
         new TestableClaudeCodeManager(
           makeMinimalSessionManager(),
           undefined,
           makeConfigManager(),
           '/tmp/test.sock',
           undefined as unknown as Database.Database, // simulate a caller bypassing TS
         );
       }).toThrow(/db argument is required/i);
     });
     ```
     This test is the contract that prevents reintroducing the silent-no-op class of regression.

8. **Update `claudeCodeManagerPermissions.test.ts`** — add a 5th arg to all 4 `new TestableClaudeCodeManager(...)` calls (lines 63, 82, 100, 119). Construct one shared in-memory db at the top of the `describe`:
   ```ts
   import Database from 'better-sqlite3';
   // ...
   describe('ClaudeCodeManager permission-mode enforcement', () => {
     let sessionManager: SessionManager;
     let db: Database.Database;

     beforeEach(() => {
       sessionManager = makeMinimalSessionManager();
       db = new Database(':memory:');
       // raw_events DDL is not needed because these tests never exercise the spawn path
     });

     afterEach(() => {
       db.close();
     });

     // ... in each test:
     const manager = new TestableClaudeCodeManager(
       sessionManager,
       undefined,
       configManager,
       '/tmp/cyboflow.sock',
       db,
     );
   ```
   The permissions tests never call `setupProcessHandlers`, so the db is unused at runtime — the change is purely to satisfy the new constructor signature.

9. **Run the gates** (paste exact commands and confirm exit 0 before reporting COMPLETED):
   ```bash
   pnpm --filter main typecheck
   pnpm --filter main lint
   pnpm --filter main test -- claudeCodeManagerWiring claudeCodeManagerPermissions
   ```
   Step 1's grep gate is the completeness check: after the edit, re-run
   ```bash
   grep -rn 'setSharedDb\|ClaudeCodeManager\.sharedDb' main/src
   ```
   and confirm zero matches outside the SPRINT-007 proposal/findings markdown (those are immutable history).

## Acceptance Criteria

See frontmatter. Compound rule: the static `sharedDb` field, the `setSharedDb` setter, every reader of those, and every test reset of those have been removed; missing-db at construction is an explicit TypeError; every test that constructs `ClaudeCodeManager` does so with a real in-memory `Database` handle.

## Test Strategy

Two existing test files (`claudeCodeManagerWiring.test.ts`, `claudeCodeManagerPermissions.test.ts`) must be updated to match the new constructor shape. The wiring test's AC-5 ("degraded mode") is replaced by a new test asserting the constructor TypeError — this is the load-bearing assertion that makes the silent-degraded-no-op a compile-time/runtime-error pair. The permissions test gets a mechanical update (5th arg = in-memory db). No new test file is created; no new test runner config is needed.

## Hardest Decision

**Positional vs options-object for the new `db` parameter.** Decision: positional 5th argument. The constructor already takes 4 positional args; introducing an options object for one new parameter would require either a breaking change for all 4 prior args or a hybrid "first-4-positional-then-options-object" shape that future readers will hate. The positional choice keeps the diff minimal (~6 added lines in the constructor, 1 line per call site) and matches the existing convention. The cost is that the next constructor parameter — if any — will face the same dilemma; that future task can do the options-object migration then if it's still warranted.

## Rejected Alternatives

- **Pass the `DatabaseService` instance instead of the raw `Database.Database`.** Rejected: `RawEventsSink`'s constructor takes a raw `Database.Database` (see `rawEventsSink.ts`), so passing the service would force `ClaudeCodeManager` to call `.getDb()` itself, adding an indirection layer without reducing coupling. The current grep gate for "RawEventsSink + db handle" stays clean if we pass the handle directly.
- **Keep the static field but make it required at construction (`assert sharedDb != null` in constructor).** Rejected: this is a half-measure. The cross-instance state leak (downside a) and the divergence from the codebase's DI pattern (downside c) both persist. The cost-savings of "only touch claudeCodeManager.ts" is illusory — the call sites at claudePanel.ts:260 and the two test files still need updating.
- **Defer until AbstractAIPanelManager is collapsed.** Rejected (overturning the FIND's framing): the ripple analysis shows the inheritance chain at `AbstractAIPanelManager` / `BaseAIPanelHandler` is not in the construction path of `ClaudeCodeManager`. Those classes wrap `claudeCodeManager` instances, they don't construct them. The collapse and this task are independent.

## Lowest Confidence Area

The change to `cliManagerFactory.ts` introduces a runtime throw when `db` is missing from `additionalOptions`. If any future caller of `cliManagerFactory.createManager('claude', ...)` forgets to pass `db`, they get an immediate startup crash. Grep currently finds only one caller (`main/src/index.ts:595`), but a future test or another bootstrap path could regress this silently. The `prerequisites` block on this plan deliberately does NOT include a grep gate for "all `createManager('claude'...)` callers pass `db`" because the constructor's runtime throw is the gate. Second uncertainty: the `Database` type import in `cliManagerFactory.ts` uses an inline `import('better-sqlite3').Database` to avoid touching the imports block. If ESLint's `@typescript-eslint/consistent-type-imports` rule flags this (the rule is unset in the main workspace config last I checked, but verify), promote it to a top-of-file `import type Database from 'better-sqlite3'` instead.
