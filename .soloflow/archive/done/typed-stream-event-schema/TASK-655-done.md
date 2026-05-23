---
id: TASK-655
sprint: SPRINT-034
epic: typed-stream-event-schema
status: done
summary: "Introduce shared/utils/extractToolResultText helper; delete shadow ToolResult interfaces in both toolFormatter files; route all unsafe string ops through the helper. Fixes FIND-SPRINT-020-9 (array-form ToolResultBlock.content). Orphaned tool-result rendering now uses extracted text instead of JSON.stringify."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: skipped_user_preference
---

# TASK-655 — Done Report

## What changed
- `shared/utils/extractToolResultText.ts` (new) — guards `ToolResultBlock.content` union; returns `string`.
- `frontend/src/utils/toolFormatter.ts` — local `interface ToolResult` removed; `ToolResultBlock` + `extractToolResultText` imported; 7 unsafe callsites rerouted through `resultText`/`resultText2`; orphaned-result branch uses `extractToolResultText`.
- `main/src/utils/toolFormatter.ts` — parallel changes; `ContentItem` union retyped to include `ToolResultBlock`.
- `frontend/src/utils/formatters.ts` — `${item.content}` replaced with `${extractToolResultText(item.content)}`.
- `frontend/src/utils/toolFormatter.test.ts` (new) — 15 tests across 5 describe blocks covering all `test_strategy.targets`.

## Verifier
- Verdict: APPROVED.
- Ground truth: frontend 336/336 pass; main 655/655 pass; pnpm typecheck clean; pnpm lint 0 errors.
- Visual: mobile not_applicable; web skipped_user_preference (renderer cannot bootstrap standalone per CLAUDE.md); macos skipped_unable (Peekaboo MCP returned audio/video capture failure twice despite both permissions granted — infrastructure issue, queued under bucket: testing).
- Findings logged: FIND-SPRINT-034-3 (`type: claude-md` — docs/VISUAL-VERIFICATION-SETUP.md troubleshooting note for Peekaboo capture failure under granted permissions).

## Code review
- Verdict: CLEAN.
- Findings logged: FIND-SPRINT-034-4 (minor — orphan-result branch has unreachable `else if`/`else` arms; redundant `resultText`/`resultText2` recomputation; orphan-image-block now renders as empty string vs prior JSON-stringified base64-filtered shape).

## Test-writer
- NO_TESTS_NEEDED — 15-test file covers every `test_strategy.target`.

## Commits
- `ae6bd11 feat(TASK-655): add extractToolResultText shared helper for ToolResultBlock.content union`
- `5a148da fix(TASK-655): remove shadow ToolResult interface and route all callsites through extractToolResultText in frontend toolFormatter`
- `a58fa0d fix(TASK-655): remove shadow ToolResult interface and route all callsites through extractToolResultText in main toolFormatter`
- `7559708 fix(TASK-655): replace unsafe ${item.content} with extractToolResultText in formatters.ts`
- `b4d95c3 test(TASK-655): add toolFormatter.test.ts covering array-content branch safety and regression baseline`
