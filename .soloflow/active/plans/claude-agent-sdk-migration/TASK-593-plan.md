---
id: TASK-593
idea: IDEA-014
status: in-flight
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/src/services/streamParser/completionDetector.ts
  - main/src/services/streamParser/__tests__/completionDetector.test.ts
  - main/src/services/streamParser/index.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/__tests__/claudeCodeManagerWiring.test.ts
  - .soloflow/active/plans/claude-agent-sdk-migration/EPIC-claude-agent-sdk-migration.md
acceptance_criteria:
  - criterion: main/src/services/streamParser/completionDetector.ts no longer exists on disk.
    verification: "test ! -e main/src/services/streamParser/completionDetector.ts; echo $?  # must print 0"
  - criterion: main/src/services/streamParser/__tests__/completionDetector.test.ts no longer exists on disk.
    verification: "test ! -e main/src/services/streamParser/__tests__/completionDetector.test.ts; echo $?  # must print 0"
  - criterion: "main/src/services/streamParser/index.ts no longer re-exports CompletionDetector, CompletionPayload, or ForcedPayload."
    verification: "grep -nE 'CompletionDetector|CompletionPayload|ForcedPayload' main/src/services/streamParser/index.ts returns 0 matches (exit 1)."
  - criterion: "No file under main/ or shared/ references the deleted detector by class name, module name, or exported type."
    verification: "grep -rn 'completionDetector\\|CompletionDetector\\|CompletionPayload\\|ForcedPayload' main/ shared/ returns 0 matches (exit 1)."
  - criterion: "pnpm typecheck succeeds (no dangling imports, no missing-module errors)."
    verification: pnpm typecheck exits 0.
  - criterion: The streamParser-package test subset still passes (every test file under main/src/services/streamParser/__tests__/ that survives this task).
    verification: pnpm --filter main test -- main/src/services/streamParser/__tests__/ exits 0.
depends_on:
  - TASK-590
  - TASK-592
estimated_complexity: low
epic: claude-agent-sdk-migration
test_strategy:
  needed: false
  justification: "This task is a pure deletion of dead code (the file and its test) plus a 2-line barrel prune. No new behavior is introduced. Sibling tests in main/src/services/streamParser/__tests__/ exist but none of them import CompletionDetector, CompletionPayload, or ForcedPayload — they import sibling modules from '../<module>' directly, not via the barrel, and none of them assert on the detector's exports. The wiring test main/src/services/__tests__/claudeCodeManagerWiring.test.ts DOES reference CompletionDetector today, but updating it belongs to TASK-590 (the claudeCodeManager rewrite); if any reference survives at this task's pre-flight, that is a T590 escape and this task must halt rather than absorb the fix. Existing parser-subset test execution (AC verification) is the regression net for the barrel prune."
---
# Delete CompletionDetector and verify SDK promise resolution replaced triple-gate watchdog

## Objective

Remove the now-unused `CompletionDetector` class, its unit test, and its barrel re-exports. The triple-gate watchdog (`childExited AND stdoutEof AND parserDrained` + 30s timeout) was an artifact of the PTY/stream-json substrate; under the SDK migration, `query()` returns a promise that resolves on the terminal `result` message and TASK-590 has already rewritten `claudeCodeManager.ts` to `await` that promise instead of orchestrating the three signals. This task is the final dead-code reap plus a global grep gate confirming no caller still imports the detector.

## Implementation Steps

1. **Completeness pre-flight grep (gate step — must run before any deletion).** Execute:
   ```bash
   grep -rn 'completionDetector\|CompletionDetector\|CompletionPayload\|ForcedPayload' main/ shared/
   ```
   The only matches that may appear are:
   - `main/src/services/streamParser/completionDetector.ts`
   - `main/src/services/streamParser/__tests__/completionDetector.test.ts`
   - `main/src/services/streamParser/index.ts` (lines 16-17)

   If `main/src/services/panels/claude/claudeCodeManager.ts` or `main/src/services/__tests__/claudeCodeManagerWiring.test.ts` (or any other file) still appears, **STOP**. Surface this as a T590 escape (report blocker; do NOT patch around it).

2. **Delete `main/src/services/streamParser/completionDetector.ts`.** Use `git rm main/src/services/streamParser/completionDetector.ts`.

3. **Delete `main/src/services/streamParser/__tests__/completionDetector.test.ts`.** Use `git rm main/src/services/streamParser/__tests__/completionDetector.test.ts`.

4. **Prune `main/src/services/streamParser/index.ts`.** Remove exactly these two lines (currently lines 16-17):
   ```
   export { CompletionDetector } from './completionDetector';
   export type { CompletionPayload, ForcedPayload } from './completionDetector';
   ```
   Stay strictly within these two lines.

5. **Re-run the completeness grep as a post-deletion gate.** Repeat step 1's `grep -rn` invocation; assert it now returns 0 matches.

6. **Run `pnpm typecheck`.** Must exit 0.

7. **Run the parser test subset.** Execute `pnpm --filter main test -- main/src/services/streamParser/__tests__/`. All surviving tests must pass.

## Acceptance Criteria

- **AC-1:** `main/src/services/streamParser/completionDetector.ts` no longer exists on disk.
- **AC-2:** `main/src/services/streamParser/__tests__/completionDetector.test.ts` no longer exists on disk.
- **AC-3:** `main/src/services/streamParser/index.ts` no longer re-exports `CompletionDetector`, `CompletionPayload`, or `ForcedPayload`.
- **AC-4:** No file under `main/` or `shared/` contains the strings `completionDetector`, `CompletionDetector`, `CompletionPayload`, or `ForcedPayload`.
- **AC-5:** `pnpm typecheck` exits 0.
- **AC-6:** `pnpm --filter main test -- main/src/services/streamParser/__tests__/` exits 0.

## Test Strategy

No new tests. The protective net is (a) the global grep gate (AC-4), (b) typecheck (AC-5), and (c) the surviving streamParser test subset (AC-6). The deleted `completionDetector.test.ts` covered detector internals — those behaviors no longer exist as a runtime concern under the SDK substrate.

## Hardest Decision

Choosing whether to allow this task to also touch `claudeCodeManager.ts` and `claudeCodeManagerWiring.test.ts` when (during execution) a survivor reference is discovered. The IDEA explicitly forbids it. I honored that — the pre-flight grep (step 1) is a gate that **halts the task and surfaces a T590 escape** rather than silently patching.

## Rejected Alternatives

- **Alternative A: Absorb `claudeCodeManagerWiring.test.ts` updates into this task.** Rejected because it expands scope into T590's blast radius.
- **Alternative B: Skip the barrel prune and let TASK-592 do it.** Rejected because T592's scope is `lineBufferer` + `jsonParser` + `streamParser` end-to-end glue — different export entries. Leaving `CompletionDetector` re-exports in `index.ts` while the implementation file is deleted produces a compile-time broken barrel.
- **Alternative C: Keep `completionDetector.test.ts` as a regression artifact.** Rejected because the file under test is being deleted — vitest would fail to resolve the import.

## Lowest Confidence Area

The plan assumes TASK-590 will both (a) rewrite `claudeCodeManager.ts` to remove all detector references and (b) update `main/src/services/__tests__/claudeCodeManagerWiring.test.ts` against the new manager shape. However, at the time of this refinement, T590's plan is not yet emitted. If T590's `files_owned` omits the wiring test, this task's AC-4 (the global grep) will fail at execution time, halting the task and surfacing the gap — which is the intended behavior, not a defect.
