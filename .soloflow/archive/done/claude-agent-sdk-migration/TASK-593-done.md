---
id: TASK-593
sprint: SPRINT-008
epic: claude-agent-sdk-migration
status: done
summary: "Delete CompletionDetector (triple-gate run-completion watchdog) + its test + barrel exports; SDK promise resolution replaces it under TASK-590's substrate."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-593 — Delete CompletionDetector watchdog

## Outcome

Final dead-code reap for the stream-json era. With TASK-590's `await for` iteration over `query()` in place, the triple-gate watchdog (`childExited AND stdoutEof AND parserDrained` + 30s timeout) is unreachable: the SDK promise resolves on the terminal `result` message, which IS the replacement signal. Removed `completionDetector.ts` (159 lines) and its unit test (415 lines), and pruned the two `streamParser/index.ts` barrel exports (`CompletionDetector` + `CompletionPayload`/`ForcedPayload` types).

Pre-flight cleanup commit 4c748ec also retired the two PTY-substrate dead tests (`claudeCodeManagerWiring.test.ts` + `claudeCodeManagerPermissions.test.ts`). They were the only files referencing `CompletionDetector` outside the streamParser dir; TASK-594's scope is too narrow to revive them; no rewriting path exists since the substrate they tested no longer exists.

## Files changed

- Deleted: `main/src/services/streamParser/completionDetector.ts`
- Deleted: `main/src/services/streamParser/__tests__/completionDetector.test.ts`
- Modified: `main/src/services/streamParser/index.ts` (removed 2 export lines)

Pre-flight cleanup (separate commit 4c748ec):
- Deleted: `main/src/services/__tests__/claudeCodeManagerWiring.test.ts`
- Deleted: `main/src/services/__tests__/claudeCodeManagerPermissions.test.ts`

## Verification

- `pnpm typecheck`: PASS (3 workspaces clean)
- `pnpm lint`: PASS (0 errors)
- Source-tree grep `completionDetector|CompletionDetector|CompletionPayload|ForcedPayload`: 0 matches
- Surviving streamParser tests: `eventRouter.test.ts` 8/8 PASS, `messageProjection.test.ts` 21/21 PASS
- Verifier: APPROVED_WITH_DEFERRED (5/6 ACs; AC-6 partial — see deferred below)
- Code-reviewer: CLEAN

## Deferred checks (queued for re-verify)

- **better-sqlite3 ABI** (`dedup_key: better_sqlite3_node_module_version_mismatch`, FIND-SPRINT-008-1) — `rawEventsSink.test.ts` 8 tests fail until `pnpm electron:rebuild` runs.
- **streamparser fixtures** (`dedup_key: streamparser_fixtures_missing`) — `schemas.test.ts` + `typedEventNarrowing.test.ts` fail with ENOENT on deleted JSON fixtures; TASK-594 owns regeneration.

## Forward references

- TASK-594 (T8) — rebuild streamParser test fixtures against the SDK wire format using `__tests__/sdkMockFactories.ts`; once that lands, the deferred fixtures-missing entry can be re-verified PASS.
- FIND-SPRINT-008-7 (claude-md, low) — future deletion-task plans should use `--exclude-dir=dist --exclude-dir=node_modules` in grep-AC commands to avoid false positives from compiled build artifacts.
