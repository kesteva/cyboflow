---
id: TASK-559
idea: IDEA-001
status: in-flight
created: "2026-05-11T00:00:00Z"
source_compound: SPRINT-001-proposal.md
files_owned:
  - main/src/services/__tests__/gitStatusManager.test.ts
files_readonly:
  - main/src/services/gitStatusManager.ts
  - main/src/services/sessionManager.ts
  - main/src/services/worktreeManager.ts
  - main/src/services/gitDiffManager.ts
  - main/src/services/gitStatusLogger.ts
  - main/src/services/gitFileWatcher.ts
  - main/src/services/gitPlumbingCommands.ts
  - main/src/utils/commandExecutor.ts
  - main/src/utils/logger.ts
  - main/src/types/session.ts
  - tests/git-status.spec.ts
  - .soloflow/active/findings/SPRINT-001-findings.md
acceptance_criteria:
  - criterion: "`pnpm --filter main test` exits 0 — the gitStatusManager test suite produces no failures"
    verification: "From repo root run `pnpm --filter main test`; the command exits 0 and the vitest summary reports 0 failed tests in the gitStatusManager file. If the decision was deletion, the file no longer exists and vitest reports no missing-suite errors."
  - criterion: "If the file is preserved, every test in it exercises a PUBLIC method or PUBLIC event of `GitStatusManager`; no test reaches into private members via the `GitStatusManagerWithPrivates` cast"
    verification: "`grep -nE 'GitStatusManagerWithPrivates|as unknown as.*Private' main/src/services/__tests__/gitStatusManager.test.ts` returns zero matches. (If the file was deleted entirely, this AC trivially passes — the grep returns zero matches.)"
  - criterion: "If the file is deleted, the deletion decision is documented in the task commit message with a one-sentence justification referencing Playwright coverage"
    verification: "`git log -1 --format=%B -- main/src/services/__tests__/gitStatusManager.test.ts` (or the parent commit if the file is removed) contains the phrase `playwright` or `tests/git-status.spec.ts` in the commit body. Reviewer reads the commit message and confirms it states the coverage delta."
  - criterion: Typecheck and lint pass after the change
    verification: "`pnpm typecheck && pnpm lint` exit 0 from repo root"
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "This task IS the test work. The deliverable is either (a) a rewritten test file that exercises the public API correctly, or (b) deletion of the broken file with documented coverage rationale."
  targets:
    - behavior: "If rewriting: `GitStatusManager.getGitStatus(sessionId)` returns the cached status when within TTL"
      test_file: main/src/services/__tests__/gitStatusManager.test.ts
      type: unit
    - behavior: "If rewriting: `getGitStatus(sessionId)` returns null when the session does not exist"
      test_file: main/src/services/__tests__/gitStatusManager.test.ts
      type: unit
    - behavior: "If rewriting: `clearSessionCache(sessionId)` removes the cached entry so the next `getGitStatus` call refetches"
      test_file: main/src/services/__tests__/gitStatusManager.test.ts
      type: unit
    - behavior: "If rewriting: `setActiveSession(id)` followed by `setActiveSession(null)` produces no exceptions and emits no leaked timers"
      test_file: main/src/services/__tests__/gitStatusManager.test.ts
      type: unit
---
# Fix or Delete gitStatusManager.test.ts

## Objective

`main/src/services/__tests__/gitStatusManager.test.ts` has 19 of 23 tests failing on the current `gitStatusManager.ts` implementation. The failures pre-date SPRINT-001 — the test file was inherited from Crystal at commit `7a5ee42` and references private methods (`executeGitCommand`, `getUntrackedFiles`, `getRevListCount`, `getDiffStats`, `checkMergeConflicts`, `fetchGitStatus`, `pollAllSessions`) and a `cache` property that the current implementation does not expose. The current public API surface is `setActiveSession`, `getGitStatus`, `refreshSessionGitStatus`, `refreshAllSessions`, `queueInitialLoad`, `clearSessionCache`, `clearAllCache`, `startPolling`, `stopPolling`, `handleVisibilityChange`, `updateGitStatusAfterRebase`, `updateProjectGitStatusAfterMainUpdate`, `cancelSessionGitStatus`, `cancelMultipleGitStatus`. The failing tests are a false signal — they appear to cover gitStatusManager but actually exercise nothing.

**Decision pre-recorded in this plan**: **DELETE the test file**, do not rewrite. Rationale:

1. The 19 failing tests target private implementation details (git plumbing parsing, cache shape, polling internals) that have been refactored multiple times since the Crystal-era authoring. The git-plumbing parsing logic has moved out of `gitStatusManager` into `gitPlumbingCommands.ts` (a separate module), so tests of `executeGitCommand`/`getRevListCount`/`getDiffStats` semantics now belong to `gitPlumbingCommands.test.ts` — a file that does not exist and is out of scope for this task.
2. The public-API surface of `gitStatusManager` is dominated by stateful, event-emitting, debounced async behavior (initial-load queue, abort controllers, throttled emits, file-watcher integration) that is genuinely awkward to mock at unit level without re-implementing half the EventEmitter contract.
3. `tests/git-status.spec.ts` (Playwright E2E) already exercises the user-visible behavior: indicator renders with a valid `data-git-state` attribute, indicator transitions through loading state when a session is clicked, indicator remains visible after loading. This covers the only externally observable contract Cyboflow users depend on.
4. The unit-test churn cost of keeping a stable rewrite (each `gitStatusManager` refactor invalidates a private-coupled test suite) is high relative to the regression catch value. Defer test re-investment until `gitStatusManager` itself is being significantly modified by a future epic.

If the reviewer disagrees with the deletion call, the second-choice option is a NARROW rewrite covering only the four `test_strategy.targets` listed above. Those four tests touch only the public surface (`getGitStatus`, `clearSessionCache`, `setActiveSession`) and require minimal mocking of `SessionManager` / `WorktreeManager` / `GitDiffManager` / `Logger`. Step 4 below records the rewrite procedure.

## Implementation Steps

1. **Confirm the deletion decision is still correct.** Read `main/src/services/gitStatusManager.ts` lines 22-180 (constructor + public methods) and `main/src/services/gitPlumbingCommands.ts`. Verify that `gitPlumbingCommands` houses the parsing logic the test file used to cover (rev-list parsing, diff-stat parsing, untracked detection, merge-conflict detection). If `gitPlumbingCommands` does NOT exist or the parsing logic is still inline in `gitStatusManager`, escalate — the deletion rationale needs revisiting because the inline parsing logic deserves SOME unit test.

2. **Confirm Playwright coverage equivalence.** Read `tests/git-status.spec.ts` lines 17-120. The two tests cover: (a) at least one `data-testid$="-git-status"` element renders with a valid `data-git-state` value from `['clean','modified','ahead','behind','diverged','conflict','untracked','unknown']`, (b) loading state appears or transitions correctly on session click. This is sufficient regression cover for the user-visible contract.

3. **Delete the test file.** `rm main/src/services/__tests__/gitStatusManager.test.ts`. If the `__tests__` directory becomes empty after the deletion, leave the empty directory — vitest tolerates empty test directories, and a future task may add tests back.

4. **Fallback path (only if step 1 reveals inline parsing logic):**
   - Rewrite the file from scratch covering the four `test_strategy.targets` behaviors against the public API.
   - Mock `SessionManager` / `WorktreeManager` / `GitDiffManager` / `Logger` as in the current file (lines 38-60 of the existing test).
   - Do NOT use `GitStatusManagerWithPrivates` casts — the rewritten file MUST exercise public methods only.
   - Skip tests that require simulating real file-watcher events (`GitFileWatcher` integration) — those are integration-level concerns better served by Playwright.

5. **Verify the test suite.** Run `pnpm --filter main test` from repo root. Expected: exits 0 with no failing tests and no missing-suite warnings. If `gitStatusManager.test.ts` was deleted, vitest reports the remaining tests (including `main/src/utils/crystalDirectory.test.ts`) passing.

6. **Typecheck and lint gate.** `pnpm typecheck && pnpm lint` exit 0.

7. **Commit.** Per atomic-commit policy, single commit. Message: `test: delete stale gitStatusManager.test.ts (covered by Playwright tests/git-status.spec.ts)`. The Playwright reference in the message satisfies AC #3.

## Acceptance Criteria

(See frontmatter. The decision recorded above is deletion. Reviewer may override on patch read; the fallback rewrite path in step 4 is encoded so the executor doesn't need to re-plan if escalation flips the call.)

## Test Strategy

The deliverable is the test file decision itself. If deletion: no new test code is written; coverage continues via `tests/git-status.spec.ts` (Playwright E2E). The Playwright coverage delta is documented in the commit message and in this plan's Hardest Decision section. If the reviewer overrides to rewrite, the four behaviors listed in `test_strategy.targets` define minimum coverage.

## Hardest Decision

Rewrite vs delete. Three factors pushed toward delete: (1) the test file's 19 failures are private-method tests, not public-API tests — fixing them by re-shimming private access produces fragile coupling that breaks on every internal refactor; (2) the parsing logic the file used to cover has been extracted to `gitPlumbingCommands.ts`, so the relevant tests now belong to a different module's test file that doesn't yet exist (and a "create new gitPlumbingCommands.test.ts" task is out of scope here); (3) Playwright covers the user-visible behavior end-to-end. The factor that pushed toward rewrite is the four public-method behaviors in `test_strategy.targets` — those ARE worth a thin unit test. The tiebreaker was the asymmetric maintenance cost: a rewritten file gets stale on the next gitStatusManager refactor (the module has 28 methods and changes often), whereas Playwright coverage is more decoupled from internal structure. Deletion now + rewrite later when a refactor settles is the cheaper path.

## Rejected Alternatives

- **Rewrite the entire 23-test suite against the public API.** Rejected. The original tests' subjects (parsing logic, polling internals, cache shape) are not on the current public surface; rewriting them is effectively a different test file, not a "fix". Better to start fresh in a focused future task if/when the need arises.
- **Mark the failing tests as `it.skip`.** Rejected. Skipped tests rot — they hide the underlying decision and signal to future maintainers that the suite is half-broken-but-tolerated. Either the tests are useful (then fix them) or they're not (then delete them).
- **Delete and immediately rewrite a narrow four-test version.** Rejected for this task's scope. The four tests in `test_strategy.targets` are listed as the FALLBACK if deletion is rejected at review. Doing both (delete the existing file AND add a new narrow file) doubles the work and inflates the diff. Defer the narrow rewrite to a future "add gitStatusManager public-API unit tests" task if the reviewer asks for it.

## Lowest Confidence Area

Whether `gitPlumbingCommands.ts` actually houses the parsing logic the deleted tests used to cover. The grep in step 1 (`Glob` showed the file exists, `gitStatusManager.ts:12` imports `fastCheckWorkingDirectory, fastGetAheadBehind, fastGetDiffStats` from it) suggests yes — but I did not read `gitPlumbingCommands.ts` in full during plan authoring. The executor MUST read it in step 1 to confirm. If the parsing logic is actually elsewhere (e.g. still inline in `gitStatusManager.fetchGitStatus`), the deletion rationale weakens and step 4's fallback rewrite becomes the preferred path — though the four-test scope still holds. The Playwright coverage claim is itself a thin assertion: `tests/git-status.spec.ts` is a smoke test, not a behavior matrix. It catches "indicator renders" but not "indicator shows the CORRECT state for a given git scenario". Deleting unit tests for parsing logic means parsing bugs would only surface in manual QA. Accepted risk for this task; future epics touching git parsing should add `gitPlumbingCommands.test.ts`.
