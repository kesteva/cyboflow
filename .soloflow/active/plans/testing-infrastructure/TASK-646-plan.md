---
id: TASK-646
idea: SPRINT-017
status: ready
created: 2026-05-18T00:00:00Z
files_owned:
  - main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts
  - main/src/orchestrator/__test_fixtures__/__tests__/loggerLikeSpy.test.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/orchestrator/__tests__/stuckDetector.test.ts
  - main/src/orchestrator/__tests__/Orchestrator.test.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpServerLifecycle.test.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - tests/helpers/cyboflowTestHarness.ts
files_readonly:
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/loggerAdapter.ts
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - docs/CODE-PATTERNS.md
acceptance_criteria:
  - criterion: "A new shared fixture file `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts` exists and exports `makeSpyLogger()` returning `LoggerLike & { calls: Array<{ level: 'info'|'warn'|'error'|'debug'; message: string; ctx?: Record<string, unknown> }> }`."
    verification: "test -f main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts AND grep -n 'export function makeSpyLogger' main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts returns exactly one match."
  - criterion: "Each of the four test methods (info/warn/error/debug) is a `vi.fn()` whose implementation pushes `{level, message, ctx}` onto the shared `calls` array on every invocation. The methods remain individually spy-able via `expect(logger.info).toHaveBeenCalledWith(...)`."
    verification: "The fixture smoke-test in __test_fixtures__/__tests__/loggerLikeSpy.test.ts asserts both `calls[0]` shape and per-method `.mock.calls[0]` reflect the invocation."
  - criterion: "All previously-local logger helpers in the six identified test files are removed and replaced with imports from the new fixture; every existing test must still pass."
    verification: "grep -rnE 'function (makeLogger|makeSilentLogger|makeFakeLogger)\\(\\)' main/src/orchestrator/__tests__ main/src/orchestrator/mcpServer/__tests__ main/src/ipc/__tests__ returns 0 matches. grep -n 'makeSpyLogger' on each of the six migrated files returns at least one match per file."
  - criterion: "Sweep-grep gate: no orchestrator/test file under main/src declares a local LoggerLike spy or no-op outside the fixture."
    verification: "grep -rnE 'makeLogger|makeSilentLogger|makeFakeLogger|nullLogger' main/src tests/helpers --include='*.ts' --exclude-dir=node_modules matches only: (a) loggerAdapter.ts production makeLoggerLike, (b) the new fixture, (c) cyboflowTestHarness.ts post-migration imports, (d) import lines in migrated tests."
  - criterion: "tests/helpers/cyboflowTestHarness.ts's `nullLogger` is replaced by an import from the new fixture."
    verification: "grep -n 'const nullLogger' tests/helpers/cyboflowTestHarness.ts returns 0 matches. grep -n 'makeSpyLogger' tests/helpers/cyboflowTestHarness.ts returns at least one match."
  - criterion: "All workspace unit-tests still pass after the migration."
    verification: "pnpm --filter main test exits 0; pnpm typecheck exits 0 across all workspaces."
  - criterion: "The fixture file complies with the standalone-typecheck invariant (no imports from electron / better-sqlite3 / services/*)."
    verification: "grep -nE \"from 'electron'|from 'better-sqlite3'|from '\\.\\./\\.\\./services\" main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts returns 0 matches."
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "The new fixture needs a smoke-test to lock in its contract (calls array shape, individual vi.fn spy-ability). Every migrated test file is in files_owned and must continue to pass after the import-and-replace edit."
  targets:
    - behavior: "makeSpyLogger() returns a LoggerLike where each method is both individually vi.fn-spy-able AND pushes {level, message, ctx} onto the shared calls array."
      test_file: "main/src/orchestrator/__test_fixtures__/__tests__/loggerLikeSpy.test.ts"
      type: unit
    - behavior: "All existing tests in workflowRegistry.test.ts continue to pass — warnCalls/errorCalls readers rewritten to logger.calls.filter(level === ...)."
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
    - behavior: "All existing tests in runLauncher.test.ts, stuckDetector.test.ts, Orchestrator.test.ts, mcpServerLifecycle.test.ts, and cyboflow.test.ts continue to pass after their local logger helpers are replaced."
      test_file: "main/src/orchestrator/__tests__/runLauncher.test.ts"
      type: unit
    - behavior: "cyboflowTestHarness launchPair flow still constructs WorkflowRegistry and RunLauncher with a satisfying LoggerLike."
      test_file: "tests/helpers/cyboflowTestHarness.ts"
      type: integration
---

# Consolidate scattered LoggerLike test helpers into a shared loggerLikeSpy fixture

## Objective

Replace the six independent local `makeLogger` / `makeSilentLogger` / `makeFakeLogger` / `nullLogger` declarations scattered across orchestrator and IPC test files with a single canonical `makeSpyLogger()` factory in `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts`. Preserves both the per-method `vi.fn()` spy surface AND adds a unified `calls` array. Sibling fixture pattern matches `dbAdapter.ts` in the same directory.

## Implementation Steps

1. **Sweep-grep gate (run first).** `grep -rnE 'makeLogger|makeSilentLogger|makeFakeLogger|nullLogger' main/src tests/helpers --include='*.ts' --exclude-dir=node_modules` — confirm pre-migration match set (6 test files + harness + production loggerAdapter). Add any missed sites to `files_owned`.

2. **Create fixture** at `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts` exporting `makeSpyLogger(): LoggerLike & { calls: LogCall[] }` with vi.fn implementations that push `{level, message, ctx}` onto `calls`.

3. **Smoke-test fixture** in `__test_fixtures__/__tests__/loggerLikeSpy.test.ts`: two cases — calls array shape + per-method spy assertion.

4. **Migrate workflowRegistry.test.ts** (most complex — bespoke warnCalls/errorCalls arrays). Remove local helper, import fixture, replace `makeLogger()` with `makeSpyLogger()`. Rewrite `logger.warnCalls[i].context` readers to `logger.calls.filter(c => c.level === 'warn')[i].ctx`. Grep `warnCalls|errorCalls|\.context` to find all sites.

5. **Migrate runLauncher.test.ts** — local helper at ~lines 39-46, replace all `makeLogger()` calls with `makeSpyLogger()`. Pure stub usage, no field-shape edits.

6. **Migrate stuckDetector.test.ts** — local helper at ~lines 147-161; new shape is superset of existing `{level, message}`.

7. **Migrate Orchestrator.test.ts** — local `makeFakeLogger` at ~lines 35-44; rename references to `makeSpyLogger`.

8. **Migrate mcpServerLifecycle.test.ts** — local helper at ~lines 104-111; update `loggerOverride?: ReturnType<typeof makeLogger>` to `ReturnType<typeof makeSpyLogger>`.

9. **Migrate cyboflow.test.ts** — local `makeSilentLogger` at ~lines 47-54; also handle inline LoggerLike object at line 284.

10. **Migrate cyboflowTestHarness.ts** — replace `nullLogger` constant with `const harnessLogger = makeSpyLogger();`. Update reader sites. Add comment: "Spy logger — calls array is unused by the harness itself but available to harness-extending tests."

11. **Completeness gate** — re-run step 1's grep; expected match set is the fixture + production loggerAdapter + import lines.

12. **Verify** `pnpm typecheck` + `pnpm --filter main test` exit 0.

## Acceptance Criteria

See frontmatter.

## Test Strategy

Fixture smoke-test locks in dual contract (vi.fn spies + calls array). Six migrated tests are regression net — workflowRegistry.test.ts requires careful field-rename (`.context` → `.ctx`); other migrations are mechanical.

## Hardest Decision

Whether to handle cyboflowTestHarness as silent (separate `makeNullLogger`) or spy (`makeSpyLogger`). Chose spy: vi.fn closures are functionally equivalent to no-ops, allocate negligibly, eliminate next consolidation pass, and offer free introspection for harness-extending tests.

## Rejected Alternatives

- Two factories (`makeSpyLogger` + `makeNullLogger`) — no functional difference, cognitive overhead.
- Defer harness migration — `nullLogger` constant would still match sweep-grep, violating AC.
- Co-locate fixture in `tests/helpers/` — breaks sibling pattern with `dbAdapter.ts`.

## Lowest Confidence Area

workflowRegistry.test.ts migration: field rename `context` → `ctx` + reader rewrites must be applied consistently. Mitigation: post-migration `grep -nE 'warnCalls|errorCalls|\.context'` must return 0 in that file.
