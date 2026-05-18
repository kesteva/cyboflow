---
id: TASK-634
idea: SPRINT-015-compound
status: ready
created: "2026-05-18T00:00:00Z"
files_owned:
  - main/src/utils/gitignoreWriter.test.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
files_readonly:
  - main/src/__test_fixtures__/tmp.ts
  - main/src/__test_fixtures__/__tests__/tmp.test.ts
acceptance_criteria:
  - criterion: "No mkdtempSync calls remain in the two target files"
    verification: "grep -n 'mkdtempSync' main/src/utils/gitignoreWriter.test.ts main/src/orchestrator/__tests__/workflowRegistry.test.ts returns 0 matches"
  - criterion: "Both files import withTempDir from the canonical fixture"
    verification: "grep -l \"from '.*__test_fixtures__/tmp'\" main/src/utils/gitignoreWriter.test.ts main/src/orchestrator/__tests__/workflowRegistry.test.ts | wc -l returns 2"
  - criterion: "After test run, no orphan dirs remain in $TMPDIR with the two known prefixes"
    verification: "pnpm --filter main test && ls \"$TMPDIR\" 2>/dev/null | grep -E 'gitignore-test-|workflow-registry-test-' | wc -l returns 0"
  - criterion: "main workspace tests exit 0"
    verification: "pnpm --filter main test exits 0"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "Refactor of test infrastructure to use the already-tested withTempDir helper (covered by main/src/__test_fixtures__/__tests__/tmp.test.ts). The behavior under test in both files (gitignore writing; workflow registry seeding) is unchanged. The two files' own existing assertions remain the regression guard for what the tests cover, and the AC-mandated `ls $TMPDIR | grep` is the regression guard for the leak fix. Sibling-test scan: no other test files exist alongside gitignoreWriter.test.ts or workflowRegistry.test.ts that this refactor could affect."
---

# Migrate 2 remaining mkdtempSync leak sites to withTempDir

## Objective

TASK-605 introduced `withTempDir` at `main/src/__test_fixtures__/tmp.ts` and migrated four of the six known leak sites. Two sites remain:
1. `main/src/utils/gitignoreWriter.test.ts:11-13` — `makeTempDir()` calls `mkdtempSync(...,'gitignore-test-')` with no `afterEach`/`afterAll` cleanup.
2. `main/src/orchestrator/__tests__/workflowRegistry.test.ts:88` — `mkdtempSync(...,'workflow-registry-test-')` runs in `beforeEach` with no matching cleanup.

Both files leak named temp dirs on every test run. This task wraps each `it` body in `withTempDir` so cleanup is unconditional, completing TASK-605's coverage scope.

## Implementation Steps

1. **Pre-flight grep — confirm both leak sites and the absence of cleanup:**
   ```
   grep -n 'mkdtempSync\|rmSync\|afterEach\|afterAll' main/src/utils/gitignoreWriter.test.ts main/src/orchestrator/__tests__/workflowRegistry.test.ts
   ```
   Expected: `mkdtempSync` at gitignoreWriter.test.ts:12 and workflowRegistry.test.ts:88; no `rmSync`/`afterEach`/`afterAll` cleanup of those temp dirs in either file.

2. **Migrate `main/src/utils/gitignoreWriter.test.ts`.**
   - Add to the imports near the top: `import { withTempDir } from '../__test_fixtures__/tmp';`
   - Delete the `makeTempDir` function (lines 11–13).
   - Convert each `it(...)` body that currently calls `const dir = makeTempDir();` into the `withTempDir` pattern:
     ```ts
     it('creates the file with the entry followed by a newline', async () => {
       await withTempDir('gitignore-test-', async (dir) => {
         ensureGitignoreEntry(dir, ENTRY);
         expect(readGitignore(dir)).toBe('.cyboflow/worktrees/\n');
       });
     });
     ```
   - There are 5 `it` blocks calling `makeTempDir` (lines 28, 36, 43, 50, 59, 67 — verify with grep). Each becomes `async () => { await withTempDir('gitignore-test-', async (dir) => { ... }); }`. The other two `it`s (the `error handling` block at lines 75 and 83) don't use `makeTempDir` — leave untouched.

3. **Migrate `main/src/orchestrator/__tests__/workflowRegistry.test.ts`.**
   - Add to the imports near the top (alongside the existing `__test_fixtures__/dbAdapter` import on line 25): `import { withTempDir } from '../../__test_fixtures__/tmp';`
   - Remove the `tmpDir = mkdtempSync(join(tmpdir(), 'workflow-registry-test-'));` assignment in `beforeEach` (line 88). Also remove the now-orphaned `let tmpDir: string;` declaration on line 82 — `tmpDir` will be injected by the callback.
   - Drop the unused imports: `mkdtempSync` from `'fs'` (line 18) and `tmpdir` from `'os'` (line 20). The `writeFileSync` import stays (used elsewhere). The `join` import from `'path'` stays.
   - Wrap each `it(...)` body that currently uses `tmpDir` in a `withTempDir('workflow-registry-test-', async (tmpDir) => { ...body... })` call. The file has 20+ `it` blocks inside `describe('seed')`, `describe('getById')`, `describe('listByProject')`, `describe('createRun')`, `describe('getRunById')`. Use grep to enumerate: `grep -n "it(" main/src/orchestrator/__tests__/workflowRegistry.test.ts`. Every one whose body references `tmpDir` must be wrapped.
   - Convert each `it('...', () => {` to `it('...', async () => { await withTempDir('workflow-registry-test-', async (tmpDir) => { ...original body... }); });`.
   - **Note for the `buildDescriptors` helper at line 59:** it accepts `dir: string` — no change needed; pass the wrapped `tmpDir` in.

4. **Run the AC completeness gate:**
   ```
   grep -n 'mkdtempSync' main/src/utils/gitignoreWriter.test.ts main/src/orchestrator/__tests__/workflowRegistry.test.ts
   ```
   Expected: 0 matches.

5. **Run `pnpm --filter main test`** — expect exit 0. All tests in both files must continue to pass.

6. **Verify no orphan temp dirs after a fresh run:**
   ```
   ls "$TMPDIR" 2>/dev/null | grep -E 'gitignore-test-|workflow-registry-test-' | wc -l
   ```
   Expected: 0.

7. **Run `pnpm --filter main typecheck`** — expect exit 0.

## Acceptance Criteria

- Zero `mkdtempSync` references in either touched file.
- Both files import `withTempDir` from the canonical fixture.
- $TMPDIR is clean of `gitignore-test-*` / `workflow-registry-test-*` after a full test run.
- `pnpm --filter main test` exits 0.

## Hardest Decision

`workflowRegistry.test.ts` has ~20 `it` blocks all sharing a single `beforeEach`-provisioned `tmpDir`. Wrapping each `it` body in `withTempDir` is verbose but matches the TASK-605 pattern; the alternative is to keep `mkdtempSync` in `beforeEach` and add an `afterEach { rmSync }`. Rejected the alternative because (a) it diverges from the project's chosen pattern, (b) it doesn't guarantee cleanup on test process kill, and (c) future migrations would have to re-revisit it. The verbosity cost is one-time.

## Rejected Alternatives

- **Add `afterEach { rmSync(tmpDir, { recursive: true, force: true }) }` to both files.** Rejected — preserves the leak risk on process kill (no `try/finally` semantics) and diverges from the canonical pattern documented in `docs/CODE-PATTERNS.md`. Would change my mind only if `withTempDir` had a known incompatibility (it doesn't).
- **Globally rename per-test variable names so the wrapping is more mechanical.** Rejected — both files already use `tmpDir` / `dir`, which are exactly what `withTempDir`'s callback supplies.

## Lowest Confidence Area

The number of `it` blocks in `workflowRegistry.test.ts` that reference `tmpDir`. The grep step in (3) is authoritative; if any new `it` blocks land after this plan is written, they must also be wrapped. The executor should re-run `grep -n 'tmpDir' main/src/orchestrator/__tests__/workflowRegistry.test.ts` as a completeness check after migration.
