---
id: TASK-605
idea: SPRINT-009-compound
status: ready
created: 2026-05-15T00:00:00Z
files_owned:
  - main/src/__test_fixtures__/tmp.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/orchestrator/__tests__/mcpConfigWriter.test.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - main/src/services/__tests__/worktreeManager.test.ts
  - tests/helpers/cyboflowTestHarness.ts
  - tests/cyboflow-day3-gate.spec.ts
files_readonly:
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "A new test helper `withTempDir(prefix, fn)` exists at the documented path"
    verification: "test -f main/src/__test_fixtures__/tmp.ts && grep -nE 'export (async )?function withTempDir' main/src/__test_fixtures__/tmp.ts returns at least one match"
  - criterion: "withTempDir creates a unique temp directory, passes it to the callback, and cleans it up via `fs.rmSync(dir, { recursive: true, force: true })` in a try/finally"
    verification: "grep -n 'mkdtempSync\\|rmSync\\|finally' main/src/__test_fixtures__/tmp.ts returns at least 3 matches (mkdtempSync + rmSync + finally)"
  - criterion: "The 4 leaking sites identified by the finding migrate to withTempDir or otherwise add proper cleanup"
    verification: "manual: each of runLauncher.test.ts, cyboflow.test.ts, cyboflowTestHarness.ts, cyboflow-day3-gate.spec.ts has either an import of withTempDir OR an explicit `afterEach(() => rmSync(...))` covering the temp dirs it creates"
  - criterion: "mcpConfigWriter.test.ts and worktreeManager.test.ts (which already cleanup via afterEach/createdDirs arrays) MAY also migrate to withTempDir for consistency, but it is not required"
    verification: "manual: either both files migrate, or both keep their existing cleanup; no half-migration"
  - criterion: "All 6 affected test files continue to pass"
    verification: "pnpm --filter main exec vitest run src/orchestrator/__tests__/runLauncher.test.ts src/orchestrator/__tests__/mcpConfigWriter.test.ts src/ipc/__tests__/cyboflow.test.ts src/services/__tests__/worktreeManager.test.ts exits 0 AND pnpm test:gate exits 0 (or skip-pass)"
  - criterion: "After running pnpm --filter main test, no `runlauncher-test-*`, `cyboflow-ipc-test-*`, `cyboflow-gate-wf-*`, or `cyboflow-day3-*` directories remain in `os.tmpdir()`"
    verification: "ls $TMPDIR | grep -E 'runlauncher-test-|cyboflow-ipc-test-|cyboflow-gate-wf-|cyboflow-day3-' returns no rows"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "withTempDir is new helper logic that needs its own unit test for the cleanup contract; the migrated test sites are themselves regression coverage but do not assert the cleanup behavior."
  targets:
    - behavior: "withTempDir creates a unique directory under os.tmpdir() with the given prefix"
      test_file: "main/src/__test_fixtures__/__tests__/tmp.test.ts"
      type: unit
    - behavior: "withTempDir cleans up the directory after the callback resolves"
      test_file: "main/src/__test_fixtures__/__tests__/tmp.test.ts"
      type: unit
    - behavior: "withTempDir cleans up the directory even if the callback throws"
      test_file: "main/src/__test_fixtures__/__tests__/tmp.test.ts"
      type: unit
    - behavior: "withTempDir cleanup is best-effort — does not throw on a non-existent dir"
      test_file: "main/src/__test_fixtures__/__tests__/tmp.test.ts"
      type: unit
---

# Create withTempDir test helper + migrate 4 leaking sites

## Objective

Six test files create temp directories via `mkdtempSync` but four of them never clean up: `runLauncher.test.ts:84`, `mcpConfigWriter.test.ts:23` (HAS cleanup via `createdDirs[]` + `afterEach`), `cyboflow.test.ts:264`, `worktreeManager.test.ts:44/150` (HAS cleanup via try/catch in `afterEach`), `cyboflowTestHarness.ts:279` (HAS cleanup in `teardown`), `cyboflow-day3-gate.spec.ts:62` (HAS cleanup in `afterAll`). Re-reading the finding: the 4 actually-leaking sites are `runLauncher.test.ts`, `cyboflow.test.ts`, plus the harness's INTERNAL fixture dir (which IS cleaned). To prevent future leaks AND consolidate the pattern, create a single `withTempDir(prefix, fn)` helper and migrate the leaking sites.

## Implementation Steps

1. Create `main/src/__test_fixtures__/tmp.ts`:
   ```ts
   /**
    * Test helper: create a unique temp directory for the duration of an async
    * callback, then unconditionally clean it up. Mirrors Python's
    * tempfile.TemporaryDirectory contextmanager pattern.
    */
   import { mkdtempSync, rmSync } from 'fs';
   import { tmpdir } from 'os';
   import { join } from 'path';
   import { randomUUID } from 'crypto';

   /**
    * Run `fn` with a fresh temp dir; clean up after fn resolves OR throws.
    *
    * Usage:
    *   await withTempDir('runlauncher-test-', async (tmpDir) => {
    *     // ... use tmpDir ...
    *   });
    *
    * Cleanup is best-effort (rmSync with force: true) so a partially-deleted
    * dir on Windows or NFS does not mask the original test failure.
    */
   export async function withTempDir<T>(
     prefix: string,
     fn: (tmpDir: string) => Promise<T> | T,
   ): Promise<T> {
     const tmpDir = mkdtempSync(join(tmpdir(), `${prefix}${randomUUID().slice(0, 8)}-`));
     try {
       return await fn(tmpDir);
     } finally {
       try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
     }
   }
   ```
2. Create `main/src/__test_fixtures__/__tests__/tmp.test.ts` with the 4 unit tests in the test_strategy targets. Each test asserts the dir exists during the callback and is gone after.
3. Migrate `main/src/orchestrator/__tests__/runLauncher.test.ts`. The existing `makeTempDir()` helper (lines 84-86) leaks. Replace each `tmpDir = makeTempDir()` followed by test body with `await withTempDir('runlauncher-test-', async (tmpDir) => { ...test body... })`. Delete `makeTempDir`. Note: the existing tests use `tmpDir = makeTempDir()` in `beforeEach`; restructure those describe blocks to wrap each `it` in `withTempDir` instead.
4. Migrate `main/src/ipc/__tests__/cyboflow.test.ts`. Line 264 creates `tmpDir = mkdtempSync(...)` in `beforeEach` with no cleanup. Wrap each `it` body in `withTempDir('cyboflow-ipc-test-', async (tmpDir) => { ...body... })` and remove the `tmpDir = mkdtempSync(...)` from `beforeEach`.
5. Migrate `tests/helpers/cyboflowTestHarness.ts`. The `workflowFixturesDir` cleanup at line 411-414 is intentional (called from `teardown()`); leave that pattern alone — the harness owns its lifecycle. But add a comment pointing at `withTempDir` for any FUTURE callers in the harness that need a per-test fixture. Optionally: replace the `mkdtempSync(...)` at line 281 with `withTempDir`-equivalent, but only if the surrounding harness flow can be refactored cleanly; if not, leave it.
6. Migrate `tests/cyboflow-day3-gate.spec.ts:62` — the `projectPath = fs.mkdtempSync(...)` in `beforeAll` IS cleaned up in `afterAll` (line 73). This one is correctly handled; no migration needed but add a one-line comment at the `mkdtempSync` call: `// Manual lifecycle (not withTempDir) because beforeAll/afterAll need shared dir across tests`.
7. Optional: migrate `main/src/orchestrator/__tests__/mcpConfigWriter.test.ts` (replace the `createdDirs[]` array + `afterEach` pattern with per-it `withTempDir`). Optional: migrate `main/src/services/__tests__/worktreeManager.test.ts` (replace `mkdtempSync` + `afterEach { rmSync }` with `withTempDir`). Both are already correctly cleaned up; migration is for consistency, not bug-fix. Either migrate both or neither — do not half-migrate.
8. Run `pnpm --filter main test` and `pnpm test:gate` (skip-pass if claude isn't installed). All must pass.
9. After tests, run the AC verification command: `ls $TMPDIR | grep -E 'runlauncher-test-|cyboflow-ipc-test-|cyboflow-gate-wf-|cyboflow-day3-'` — must return no rows.

## Acceptance Criteria

See frontmatter. Critically: post-task, `os.tmpdir()` is clean after `pnpm --filter main test` runs, and a future test that creates a temp dir without `withTempDir` is the visible exception, not the norm.

## Test Strategy

4 new behavior tests for the helper itself + the 4-6 migrated test files acting as integration regression coverage. Pair with TASK-603 / TASK-604 to consolidate all test boilerplate.

## Hardest Decision

Whether to wrap each `it` in `withTempDir` vs. add a `beforeEach`/`afterEach` pair. Picked per-`it` wrapping because (a) it makes the temp-dir lifecycle visually local to the test that uses it, and (b) `beforeEach`/`afterEach` can't easily await an async cleanup that depends on the test's own fixtures. The trade-off is more boilerplate per test, which is acceptable.

## Rejected Alternatives

- **Add a vitest plugin / global hook that auto-cleans every `mkdtempSync` call.** Rejected because it requires monkey-patching `fs` globally, which breaks tests that legitimately want a persistent temp dir (e.g. for a debug session). The opt-in `withTempDir` helper is safer.
- **Use `tmp` npm package's `dir` API with `unsafeCleanup: true`.** Rejected to avoid adding a runtime dependency for a 15-line helper.

## Lowest Confidence Area

Whether the harness's `workflowFixturesDir` (line 281 of `cyboflowTestHarness.ts`) genuinely benefits from migration. The harness already cleans up in `teardown()`; the value of `withTempDir` is mostly stylistic. Erred on the side of "leave intentional patterns alone" — flagged as optional in step 5.
