---
id: TASK-592
sprint: SPRINT-008
epic: claude-agent-sdk-migration
status: done
summary: "Delete legacy stream-json parser plumbing (lineBufferer / jsonParser / streamParser + 3 tests + 11 fixtures); prune streamParser/index.ts barrel to survivor symbols."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-592 — Delete legacy stream-json parser plumbing

## Outcome

Pure deletion sweep. TASK-590's runtime switch to SDK typed events made `LineBufferer`, `JSONParser`, and `ClaudeStreamParser` unreachable. Removed all three source files, their three dedicated unit-test suites, the 11 wire-format JSON fixtures they consumed (`__fixtures__/README.md` preserved), and pruned the `streamParser/index.ts` barrel to re-export only survivor symbols (`EventRouter`, `RawEventsSink`, `MessageProjection`, `TypedEventNarrowing`, `CompletionDetector`, `ILogger`, `CompletionPayload`, `ForcedPayload`). The `@example` JSDoc was updated to use a survivor pair. EPIC success-signal #6 now achievable.

## Files changed

- Deleted: `main/src/services/streamParser/lineBufferer.ts`
- Deleted: `main/src/services/streamParser/jsonParser.ts`
- Deleted: `main/src/services/streamParser/streamParser.ts`
- Deleted: 3 sibling test files under `__tests__/`
- Deleted: 11 fixture files under `__fixtures__/`
- Modified: `main/src/services/streamParser/index.ts` (pruned + JSDoc example updated)

## Verification

- `pnpm typecheck` (direct `tsc --noEmit` on main + frontend): PASS
- Verifier: APPROVED 7/7 ACs (treated AC-6's comment-only matches as "MET in spirit" per plan's scope-discipline contract)
- Code-reviewer: CLEAN

## Acknowledged residual

FIND-SPRINT-008-5: stale JSDoc/comment-only references to deleted symbols remain in:
- `main/src/ipc/session.ts:34` (JSDoc comment line)
- `main/src/services/__tests__/claudeCodeManagerWiring.test.ts:5,268` (JSDoc + inline comment)

No symbol imports or runtime usage — comment text only. Both files are outside this task's `files_owned`. claudeCodeManagerWiring.test.ts is already in the "intentionally red, owned by TASK-594" bucket. The plan's Rejected Alternative §3 explicitly rejects silent cross-sibling edits.

## Known acceptable runtime breakage

Per the plan: `schemas.test.ts` and `typedEventNarrowing.test.ts` both call `loadFixture()` against the deleted JSON corpus and will fail at runtime. That breakage is TASK-594's explicit scope.

## Forward references

- TASK-593 (T7) — re-wire `eventRouter` / `messageProjection` / `rawEventsSink` / `typedEventNarrowing` to consume the SDK `SDKMessage` stream directly. The substrate-portable Zod schemas in `schemas.ts` (retained, TASK-589) are the validation layer.
- TASK-594 (T8) — migrate fixtures from CLI wire format to SDK wire format and resurrect `schemas.test.ts` + `typedEventNarrowing.test.ts`. Also cleans up the stale comment references in FIND-SPRINT-008-5.
