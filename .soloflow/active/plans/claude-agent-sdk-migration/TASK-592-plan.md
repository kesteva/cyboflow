---
id: TASK-592
idea: IDEA-014
status: in-flight
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/src/services/streamParser/lineBufferer.ts
  - main/src/services/streamParser/jsonParser.ts
  - main/src/services/streamParser/streamParser.ts
  - main/src/services/streamParser/index.ts
  - main/src/services/streamParser/__tests__/lineBufferer.test.ts
  - main/src/services/streamParser/__tests__/jsonParser.test.ts
  - main/src/services/streamParser/__tests__/streamParser.test.ts
  - main/src/services/streamParser/__fixtures__/assistant.json
  - main/src/services/streamParser/__fixtures__/result_error_during_execution.json
  - main/src/services/streamParser/__fixtures__/result_error_max_budget_usd.json
  - main/src/services/streamParser/__fixtures__/result_error_max_turns.json
  - main/src/services/streamParser/__fixtures__/result_success.json
  - main/src/services/streamParser/__fixtures__/stream_event.json
  - main/src/services/streamParser/__fixtures__/system_api_retry.json
  - main/src/services/streamParser/__fixtures__/system_compact.json
  - main/src/services/streamParser/__fixtures__/system_init.json
  - main/src/services/streamParser/__fixtures__/user_array_content.json
  - main/src/services/streamParser/__fixtures__/user_string_content.json
files_readonly:
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/schemas.ts
  - main/src/services/streamParser/completionDetector.ts
  - main/src/services/streamParser/types.ts
  - main/src/services/streamParser/__tests__/eventRouter.test.ts
  - main/src/services/streamParser/__tests__/rawEventsSink.test.ts
  - main/src/services/streamParser/__tests__/messageProjection.test.ts
  - main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts
  - main/src/services/streamParser/__tests__/schemas.test.ts
  - main/src/services/streamParser/__tests__/completionDetector.test.ts
  - main/src/services/streamParser/__fixtures__/README.md
  - main/src/ipc/session.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
acceptance_criteria:
  - criterion: The three deleted source files no longer exist.
    verification: "test ! -e main/src/services/streamParser/lineBufferer.ts && test ! -e main/src/services/streamParser/jsonParser.ts && test ! -e main/src/services/streamParser/streamParser.ts; expect exit 0."
  - criterion: The three deleted test files no longer exist.
    verification: "test ! -e main/src/services/streamParser/__tests__/lineBufferer.test.ts && test ! -e main/src/services/streamParser/__tests__/jsonParser.test.ts && test ! -e main/src/services/streamParser/__tests__/streamParser.test.ts; expect exit 0."
  - criterion: All 11 stream-json wire-format JSON fixtures are deleted.
    verification: "ls main/src/services/streamParser/__fixtures__/*.json 2>/dev/null | wc -l; expect output `0`."
  - criterion: "`streamParser/index.ts` exists and re-exports only surviving symbols (EventRouter, RawEventsSink, MessageProjection, TypedEventNarrowing, CompletionDetector, ILogger types)."
    verification: "grep -E 'LineBufferer|JSONParser|ClaudeStreamParser' main/src/services/streamParser/index.ts; expect exit 1 (no matches). grep -cE 'EventRouter|RawEventsSink|MessageProjection|TypedEventNarrowing|CompletionDetector' main/src/services/streamParser/index.ts; expect count >= 5."
  - criterion: No production code or surviving tests under main/ or shared/ import the deleted modules by relative path.
    verification: "grep -rn \"from ['\\\"].*streamParser/(lineBufferer|jsonParser|streamParser)['\\\"]\" main/ shared/ 2>/dev/null | grep -v node_modules; expect exit 1."
  - criterion: "No production code or surviving tests reference the deleted exported symbols `LineBufferer`, `JSONParser`, or `ClaudeStreamParser`."
    verification: "grep -rnE '\\b(LineBufferer|JSONParser|ClaudeStreamParser)\\b' main/ shared/ 2>/dev/null | grep -v node_modules; expect exit 1. If matches remain only in claudeCodeManager.ts, T5 (TASK-590) did not complete its prerequisite scope — surface as a finding and stop."
  - criterion: "`pnpm typecheck` exits 0."
    verification: pnpm typecheck; expect exit 0 and zero TypeScript errors.
depends_on:
  - TASK-590
estimated_complexity: low
epic: claude-agent-sdk-migration
test_strategy:
  needed: false
  justification: "This task is a pure-deletion sweep with no new behavior to test. Verification is via filesystem checks, grep, and `pnpm typecheck`. Surviving sibling tests in `__tests__/` are listed in files_readonly and intentionally not modified — `typedEventNarrowing.test.ts` and `schemas.test.ts` both call `loadFixture()` against `__fixtures__/*.json` and WILL fail at runtime after this task. That runtime breakage is the explicit responsibility of TASK-594 (T8) per the EPIC; flagging the breakage as a finding is the correct exit state, not a reason to modify those tests here."
---
# Delete stream-json line-buffer and JSON-parser plumbing files and their tests

## Objective

Under the Claude Agent SDK migration, the runtime no longer parses a stream-json byte stream — the SDK emits typed events directly. The `LineBufferer`, `JSONParser`, and `ClaudeStreamParser` end-to-end glue are dead code as of TASK-590's rewrite of `claudeCodeManager.ts`. This task removes those three source files, their three dedicated unit-test suites, the 11-fixture wire-format corpus they consume, and prunes the `streamParser/index.ts` barrel to re-export only surviving symbols. Surviving files (`eventRouter`, `messageProjection`, `rawEventsSink`, `typedEventNarrowing`, `schemas`, `completionDetector`, `types`) are not touched — their migration to SDK-shaped inputs is handled by sibling tasks T7 (TASK-593) and T8 (TASK-594).

## Implementation Steps

1. **Inventory gate.** Confirm on-disk state matches plan expectations:
   ```bash
   ls main/src/services/streamParser/
   ls main/src/services/streamParser/__tests__/
   ls main/src/services/streamParser/__fixtures__/
   ```
   At refinement time: 11 source files, 9 test files, 12 fixture-dir entries (11 JSON + 1 README).

2. **Pre-flight that T5 (TASK-590) completed its rewrite.** Run:
   ```bash
   grep -nE '\b(LineBufferer|JSONParser|ClaudeStreamParser)\b' main/src/services/panels/claude/claudeCodeManager.ts
   ```
   Expect exit 1 (no matches). If matches exist, stop and surface as a finding.

3. **Delete the three retired source files:**
   ```bash
   rm main/src/services/streamParser/lineBufferer.ts
   rm main/src/services/streamParser/jsonParser.ts
   rm main/src/services/streamParser/streamParser.ts
   ```

4. **Delete the three retired test files:**
   ```bash
   rm main/src/services/streamParser/__tests__/lineBufferer.test.ts
   rm main/src/services/streamParser/__tests__/jsonParser.test.ts
   rm main/src/services/streamParser/__tests__/streamParser.test.ts
   ```

5. **Delete the 11 wire-format JSON fixtures:**
   ```bash
   rm main/src/services/streamParser/__fixtures__/assistant.json \
      main/src/services/streamParser/__fixtures__/result_error_during_execution.json \
      main/src/services/streamParser/__fixtures__/result_error_max_budget_usd.json \
      main/src/services/streamParser/__fixtures__/result_error_max_turns.json \
      main/src/services/streamParser/__fixtures__/result_success.json \
      main/src/services/streamParser/__fixtures__/stream_event.json \
      main/src/services/streamParser/__fixtures__/system_api_retry.json \
      main/src/services/streamParser/__fixtures__/system_compact.json \
      main/src/services/streamParser/__fixtures__/system_init.json \
      main/src/services/streamParser/__fixtures__/user_array_content.json \
      main/src/services/streamParser/__fixtures__/user_string_content.json
   ```
   Leave `__fixtures__/README.md` in place.

6. **Prune `streamParser/index.ts`.** Remove only:
   - `export { LineBufferer } from './lineBufferer';`
   - `export { JSONParser } from './jsonParser';`
   - `export { ClaudeStreamParser } from './streamParser';`
   - Update the `@example` JSDoc to use a survivor pair.
   - Keep all other lines exactly as-is. Final file re-exports: `TypedEventNarrowing`, `EventRouter`, `CompletionDetector`, `CompletionPayload`, `ForcedPayload`, `RawEventsSink`, `MessageProjection`, `ILogger`.

7. **Sweep grep — confirm no production or test code imports the deleted modules.** Both greps must exit 1:
   ```bash
   grep -rnE "from ['\"].*streamParser/(lineBufferer|jsonParser|streamParser)['\"]" main/ shared/ 2>/dev/null
   grep -rnE "\b(LineBufferer|JSONParser|ClaudeStreamParser)\b" main/ shared/ 2>/dev/null
   ```
   If matches return, stop and surface as a finding.

8. **Typecheck gate:**
   ```bash
   pnpm typecheck
   ```
   Must exit 0.

9. **Surviving-test sanity check (informational).** Optionally run the 4 fixture-free surviving tests (eventRouter, rawEventsSink, messageProjection, completionDetector). DO NOT run `schemas.test.ts` or `typedEventNarrowing.test.ts` — both fail expected ENOENT (T8 scope).

## Acceptance Criteria

1. The three retired source files no longer exist.
2. The three retired test files no longer exist.
3. All 11 wire-format JSON fixtures no longer exist; `__fixtures__/README.md` untouched.
4. `streamParser/index.ts` contains zero references to `LineBufferer`, `JSONParser`, or `ClaudeStreamParser`.
5. Sweep grep returns no matches in production or surviving tests.
6. No surviving file references the deleted exported symbols.
7. `pnpm typecheck` exits 0.

## Test Strategy

No new tests. Deletion-only sweep; the gate is `pnpm typecheck` plus the grep sweep in step 7.

## Hardest Decision

Whether to **delete** `streamParser/index.ts` entirely or **prune** it. Reading the file resolved the question: `main/src/ipc/session.ts:19` imports survivors through this barrel. Deleting the file would break that import and force editing a file outside `files_owned`. **Prune, not delete.**

A secondary hard call was whether to delete `__fixtures__/README.md`. I chose `files_readonly` (keep) because T8 will revisit the fixture-driven test pattern and is the natural owner.

## Rejected Alternatives

- **Delete `streamParser/index.ts` outright.** Rejected: would break `session.ts:19` and `claudeCodeManager.ts:18-19`.
- **Also delete `__fixtures__/README.md` and the now-empty-ish `__fixtures__/` dir.** Rejected: README is co-owned-by-narrative with T8's fixture-pattern retirement.
- **Silently fix `claudeCodeManager.ts` if T5 left a stale `ClaudeStreamParser` import.** Rejected: cross-sibling silent edits are the highest-cost class of plan-quality bug. Surface as a finding.
- **Run `pnpm test` over the full streamParser test directory as a gate.** Rejected: would either require T6 to fix T8's work (scope creep) or produce noisy red signals.

## Lowest Confidence Area

**The state of `claudeCodeManager.ts` at the moment T6 starts.** The plan assumes TASK-590 (T5) has already removed every `LineBufferer | JSONParser | ClaudeStreamParser` import. Implementation step 2 probes for this before any deletion. If T5 partially rewrote the file, `pnpm typecheck` in step 8 will fail. The plan instructs the executor to surface that as a finding and stop, NOT to silently edit `claudeCodeManager.ts`.

Secondary concern: if a `.json` fixture other than the 11 listed exists at execution time, step 1's inventory check should catch it. The directory-cardinality assertion in AC 3 (`ls *.json | wc -l == 0`) backstops this.
