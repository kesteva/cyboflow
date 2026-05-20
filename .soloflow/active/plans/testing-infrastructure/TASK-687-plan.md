---
id: TASK-687
idea: SPRINT-026-compounder
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/orchestrator/runExecutor.ts
files_readonly:
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/services/streamParser/index.ts
  - shared/types/claudeStream.ts
  - shared/types/workflows.ts
  - .soloflow/active/findings/SPRINT-026-findings.md
  - .soloflow/archive/done/orchestrator-and-trpc-router/TASK-640-done.md
acceptance_criteria:
  - criterion: "pnpm --filter main test exits 0 for runExecutor.test.ts specifically (all describe blocks pass)"
    verification: "pnpm --filter main exec vitest run main/src/orchestrator/__tests__/runExecutor.test.ts exits 0"
  - criterion: "The four originally-failing test cases (per FIND-SPRINT-026-10) are present and passing — lifecycle transitions, bridgeEvents source arg, panelId/runId alignment"
    verification: "grep -nE 'lifecycle transitions|source arg|panelId/runId alignment|bridge drops output event when panelId has run- prefix' main/src/orchestrator/__tests__/runExecutor.test.ts returns ≥4 matches AND a verbose vitest run shows each as PASS"
  - criterion: "If production code in runExecutor.ts was changed, the change is documented in a code comment naming the FIND identifier (FIND-SPRINT-026-10)"
    verification: "If `git diff main main/src/orchestrator/runExecutor.ts` shows changes, then `grep -nE 'FIND-SPRINT-026-10' main/src/orchestrator/runExecutor.ts` returns ≥1 match; vacuous if production code is untouched"
  - criterion: "A root-cause summary is appended to the done report classifying each of the 4 failures as test-assertion drift OR production regression"
    verification: "After execution, the done report contains a section 'Root-cause classification' listing each of the 4 failures with verdict"
  - criterion: "pnpm test:unit exits 0 (excluding the separately-tracked cyboflowSchema.test.ts failure)"
    verification: "pnpm test:unit exits 0, OR exits non-0 only because of cyboflowSchema.test.ts"
  - criterion: "pnpm typecheck exits 0"
    verification: "pnpm typecheck exits 0"
depends_on: []
estimated_complexity: medium
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "This task IS the test fix. The test file itself is the primary artifact. Beyond making the existing 4 failing cases pass, no new test cases are required — but the executor must avoid the common failure mode of 'making the test pass by mutating the assertion to match wrong behavior'. The root-cause classification in the done report is the safeguard."
  targets:
    - behavior: "lifecycle transitions: onLifecycleTransition routes each ExecutionPhase to the right transition helper (sdk_initialized → running, completed → completed, canceled → canceled, pre_spawn/post_spawn → no-op)"
      test_file: "main/src/orchestrator/__tests__/runExecutor.test.ts"
      type: unit
    - behavior: "bridgeEvents source arg integration: lifecycleTransitions.running() fires when source emits output event with matching panelId; exactly 1 raw_events row inserted (skipPersistence=true on bridge, single-INSERT guarantee)"
      test_file: "main/src/orchestrator/__tests__/runExecutor.test.ts"
      type: integration
    - behavior: "panelId/runId alignment: bridge drops output events when panelId has the old 'run-<runId>' prefix (negative test locking in the post-TASK-663 invariant)"
      test_file: "main/src/orchestrator/__tests__/runExecutor.test.ts"
      type: integration
prerequisites:
  - check: "node -e \"require('better-sqlite3')\" 2>&1 | grep -qE 'NODE_MODULE_VERSION' && echo MISMATCH || echo OK"
    fix: "pnpm electron:rebuild"
    description: "FIND-SPRINT-026-4 confirms rawEventsSink.test.ts hit NODE_MODULE_VERSION mismatch in SPRINT-026. Probe before reproducing to avoid mis-attributing a binary mismatch as a logic regression."
    blocking: true
---

# B4 — Investigate and fix pre-existing runExecutor.test.ts failures

## Objective

Resolve FIND-SPRINT-026-10: `main/src/orchestrator/__tests__/runExecutor.test.ts` has 4 pre-existing test failures (lifecycle transitions, `bridgeEvents` source arg, panelId/runId alignment) that have been suppressed across at least SPRINT-025 and SPRINT-026 — they reproduce at HEAD~3, so they predate this work. They mask real regressions on every `pnpm test:unit` run. Reproduce locally, classify each as **test-assertion drift** OR **production regression**, apply the minimal correct fix per case, and unblock `pnpm test:unit` exit 0. Document each verdict in the done report.

## Implementation Steps

1. **Verify the binary prereq:** run `node -e "require('better-sqlite3')"`. If it errors with NODE_MODULE_VERSION, run `pnpm electron:rebuild` and re-probe.

2. **Reproduce the failures cold:** `pnpm --filter main exec vitest run main/src/orchestrator/__tests__/runExecutor.test.ts --reporter=verbose 2>&1 | tee /tmp/runExecutor-baseline.txt`. Record exact failure messages and line numbers.

3. **For each failure, walk the codebase to classify it:**
   - **Lifecycle transitions** — re-read `runExecutor.ts` `onLifecycleTransition` mapping; verify `sdk_initialized → running`, `completed → completed`, `canceled → canceled`, `pre_spawn/post_spawn → no-op` fires. If production is correct and the assertion is wrong → drift. If a mapping is missing or wrong → regression.
   - **bridgeEvents source arg integration** — re-read `RunExecutor.bridgeEvents` and confirm the `this.source` arg, `skipPersistence: true` flag, and `onFirstMessage` wiring match the test's expectations.
   - **panelId/runId alignment** — re-read `runEventBridge.ts` filter `if (p.panelId !== runId || p.type !== 'json') return;`. Confirm the invariant holds; check the test setup.

4. **Apply the minimal correct fix per case:**
   - **Test-assertion drift:** update the assertion to match the current contract. Do NOT silently weaken assertions to coerce a pass — add a one-line comment naming the SPRINT/TASK that introduced the API change.
   - **Production regression:** fix `runExecutor.ts`. Add a code comment `// FIND-SPRINT-026-10 regression fix: <what was wrong, what is now correct>`. Keep the change minimal.

5. **Re-run the test file** and confirm 0 failures.

6. **Re-run `pnpm test:unit`** — must exit 0 (or non-0 ONLY because of cyboflowSchema.test.ts).

7. **Run `pnpm typecheck`** — exit 0.

8. **Write the done-report root-cause section** with one row per failure: `| Failure | Verdict | Fix location |`.

9. **Completeness gate** — re-run the ACs above.

## Acceptance Criteria

See frontmatter.

## Test Strategy

The 4 originally-failing test cases ARE the test artifact. Each must pass after the fix. The danger pattern is "make the test pass by weakening the assertion" — the root-cause-classification AC is the safeguard. If a failure cannot be cleanly classified, escalate as HUMAN_NEEDED rather than shipping an opaque "the test passes now" fix.

## Hardest Decision

Whether each failure is test-assertion drift or production regression. Heuristic: read the production code assuming it is correct, then ask "what would the assertion say if I wrote it today?" — match → regression, structural diff → drift. When in doubt, prefer drift, because the production code has been running in real runs since TASK-640 / TASK-650 / TASK-662 / TASK-663.

## Rejected Alternatives

- **Add `.skip` to the 4 failing cases:** rejected — exactly the suppression pattern that masked the issue.
- **Rewrite the entire test file from scratch:** rejected — too broad; the file has substantial coverage value worth preserving.
- **Move the 4 cases to a `.failing.test.ts` skipped by default:** rejected — visible suppression is still suppression.

## Lowest Confidence Area

The "bridgeEvents source arg integration" test contains the most coupled assertions: real EventEmitter, real DB, real EventRouter, real RawEventsSink, then asserts exactly 1 raw_events row exists. If `cnt=2`, the production `skipPersistence` flag is missing. If `cnt=0`, the CCM-style sink pipeline listener is broken. Either is a production regression with a corresponding `FIND-SPRINT-026-10` comment in `runExecutor.ts`.
