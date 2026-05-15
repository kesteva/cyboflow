---
id: TASK-594
sprint: SPRINT-008
epic: claude-agent-sdk-migration
status: done
summary: "Migrate surviving stream-parser tests (schemas + typedEventNarrowing) from disk fixtures to inline SDK-mock factories; 55/55 testable cases pass."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-594 — Migrate parser tests to inline SDK-mock factories

## Outcome

Replaced the `__fixtures__/*.json`-driven test pattern with inline, typed SDK-mock factories. Created `sdkMockFactories.ts` exporting 11 named factory functions (`systemInit`, `systemApiRetry`, `systemCompact`, `assistant`, `userStringContent`, `userArrayContent`, `resultSuccess`, `resultErrorMaxTurns`, `resultErrorMaxBudgetUsd`, `resultErrorDuringExecution`, `streamEvent`), each returning a fully-typed concrete variant from the retargeted `shared/types/claudeStream.ts` union with `Partial<T>` override support. Rewrote `schemas.test.ts` and `typedEventNarrowing.test.ts` to consume the factories instead of `loadFixture()`/`readFileSync` — `node:fs` and `node:path` imports removed. All 10 describe blocks in `schemas.test.ts` preserved verbatim; substrate-independent assertions intact.

Factory literal values were sourced from the deleted fixture JSONs recovered via `git show` on the deleted paths, then narrowed to the SDK-retargeted union (TASK-589's additive shape change is automatically honored — `_typeCheck` would have caught any drift).

## Files changed

- New: `main/src/services/streamParser/__tests__/sdkMockFactories.ts` (11 factory functions)
- Modified: `main/src/services/streamParser/__tests__/schemas.test.ts`
- Modified: `main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts`

## Verification

- `pnpm typecheck`: PASS (3 workspaces clean; factories conform to retargeted ClaudeStreamEvent union)
- `pnpm lint`: PASS (0 errors, 303 pre-existing warnings; no new `any`)
- Test run: 55/55 PASS (schemas 17, typedEventNarrowing 9, eventRouter 8, messageProjection 21)
- Verifier: APPROVED_WITH_DEFERRED (8/8 ACs met)
- Code-reviewer: CLEAN

## Known acceptable deferral

`rawEventsSink.test.ts` (8 cases) fails on pre-existing FIND-SPRINT-008-1 (better-sqlite3 NODE_MODULE_VERSION 136 vs 127 ABI mismatch). Environmental, requires `pnpm electron:rebuild`. Not a TASK-594 regression — `new Database(':memory:')` throws in `makeDb()` before reaching any test logic; reproduces identically at parent commit.

## Forward references

- TASK-595 (T9) — end-to-end smoke verification will close the EPIC.
- `streamParser/__fixtures__/README.md` could be deleted in a future dead-code sweep — it documents a JSON-fixture pattern that no longer exists. (Out of scope for TASK-594, which is files-owned-bounded.)
