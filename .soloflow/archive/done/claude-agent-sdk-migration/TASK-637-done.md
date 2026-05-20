---
id: TASK-637
sprint: SPRINT-024
epic: claude-agent-sdk-migration
status: done
summary: "Created parseJsonMessage adapter + tests; replaced double-casts and removed FIXME breadcrumbs in MessagesView/RichOutputView. Discovered the underlying IPC type declaration is stale (declared ClaudeJsonMessage[], runtime UnifiedMessage[]); applied Option A fix to restore output rendering. Stale IPC declarations + adapter dead-code retention queued as FIND-SPRINT-024-4."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_unable
---

## Summary

Introduced `parseJsonMessage` adapter module with `JSONMessage` / `UserPromptMessage` / `SessionInfo` type exports and 5 unit tests (all pass). Replaced the `as unknown as JSONMessage[]` and `as unknown as UserPromptMessage[]` double-casts in MessagesView.tsx and RichOutputView.tsx. Removed the two FIXME(SPRINT-015) breadcrumbs.

Code review caught that `panels:get-json-messages` is declared as `Promise<IPCResponse<ClaudeJsonMessage[]>>` in `electron.d.ts:317` but at runtime returns `UnifiedMessage[]` (from `main/src/ipc/session.ts:937-961` via `projectStoredOutputs` → `MessageProjection`). The adapter was designed against the declared type — feeding it UnifiedMessages dropped all assistant output, tool calls, thinking, and tool results from RichOutputView's rendered view. Applied the reviewer's Option A: bypass the adapter for the IPC consumption path and push UnifiedMessages straight through to `messageTransformer.transform()` (an identity cast). parseJsonMessage module + tests retained for future use (or removal alongside the deeper IPC type fix in FIND-SPRINT-024-4).

## Verifier

APPROVED (both rounds) — all 6 ACs met. Visual: web/macos skipped_unable (no Electron running); mobile skipped_user_preference. Logged FIND-SPRINT-024-5 (MessagesView session_info card may be permanently empty against current UnifiedMessage shape — predates this commit but surfaced during verification).

## Code review

Round 1: IMPROVEMENTS_NEEDED (1 important: runtime regression where parseJsonMessage filter drops all output messages in RichOutputView). Fix applied via Option A. Code review cap reached.

## Test-writer

NO_TESTS_NEEDED. Existing parseJsonMessage tests cover all behaviors in `test_strategy.targets`. Integration regression is UI-level (Electron-required) and out of scope per the plan's own test_strategy.

## Follow-up findings

- **FIND-SPRINT-024-4** (high): IPC declarations in electron.d.ts:86, 317 are stale (declared ClaudeJsonMessage[], runtime UnifiedMessage[]). Either fix the types or remove the dead adapter.
- **FIND-SPRINT-024-5** (med): MessagesView's session_info detection logic is stale against current UnifiedMessage shape; the realtime handler at lines 67-119 also retains the legacy check.

## Commits

- `4d79ddb feat(TASK-637): replace double-casts with parseJsonMessage adapter`
- `bb926cd fix(TASK-637): restore UnifiedMessage flow in RichOutputView (parseJsonMessage adapter is shape-mismatched)`
