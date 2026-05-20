---
id: TASK-657
sprint: SPRINT-025
epic: standalone-terminal-panels
status: done
summary: "Fixed panels:initialize cwd routing to prefer customState.cwd over options.cwd and persist resolved cwd into customState before PTY spawn"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-657: Fix panels:initialize cwd routing and persist cwd in panel customState

## Outcome

Added a typed cwd-resolver helper `resolveTerminalCwd` to `main/src/ipc/panels.ts` that resolves cwd in priority order (`customState.cwd` → `options.cwd` → `process.cwd()`) and persists the resolved cwd into `customState.cwd` via `panelManager.updatePanel` before calling `terminalPanelManager.initializeTerminal`. The user-defined type guard `hasCwdString` narrows safely without any `as any` casts. New unit test file `panelsInitialize.test.ts` covers 5 cases (A–E) including an extra boundary case for empty-string customState.cwd added by test-writer.

## Changes

- `main/src/ipc/panels.ts` — added `hasCwdString` type guard, `resolveTerminalCwd` helper, rewrote terminal branch to persist resolved cwd before init
- `main/src/ipc/__tests__/panelsInitialize.test.ts` — new file with 5 test cases

## Commits

- `1c4e3ea` — `fix(TASK-657): persist and prefer customState.cwd in panels:initialize`
- `61c90b4` — `test(TASK-657): add Case E for empty-string customState.cwd boundary`

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm --filter main test: 5/5 new cases pass; 5 pre-existing failures unrelated (FIND-SPRINT-025-1, FIND-SPRINT-025-2)
- shadow-verifier verdict: APPROVED
- code-reviewer verdict: CLEAN
- test-writer: TESTS_WRITTEN (added Case E)

## Out-of-diff findings filed

- FIND-SPRINT-025-7 — cwd-narrowing logic now exists in three places (panels.ts, terminalPanelManager.saveTerminalState, terminalPanelManager.restoreTerminalState); candidate for shared utility extraction.
