---
id: TASK-677
sprint: SPRINT-027
epic: standalone-terminal-panels
status: done
summary: "Promoted hasCwdString guard to shared/types/panels.ts; migrated 4 cwd-narrowing sites (incl. removing unsafe TerminalPanelState cast in renderer); added 7 unit tests."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_unable
visual_macos: not_applicable
---

# TASK-677 — Done

## What changed
- shared/types/panels.ts — added hasCwdString export
- main/src/ipc/panels.ts — replaced local copy with shared import; removed unused ToolPanelState import
- main/src/services/terminalPanelManager.ts — migrated saveTerminalState narrowing to guard; restoreTerminalState uses inline guard-equivalent (intentional non-use, documented)
- frontend/src/components/panels/TerminalPanel.tsx — replaced unsafe `as TerminalPanelState | undefined` cast with hasCwdString guard
- main/src/__tests__/hasCwdString.test.ts — new file, 7 unit tests using `as unknown as Parameters<typeof hasCwdString>[0]` codebase idiom

## Verification
- vitest target: 7/7 hasCwdString suite passes.
- Frontend tests: 248/248 pass.
- Main tests: 548/549 (pre-existing killProcess timeout).
- Typecheck + lint: pass.

## Findings logged
- FIND-SPRINT-027-5 (visual_web electron renderer unreachable — collapsed under existing visual_web_electron_unreachable dedup_key)

## Commits
- e2b96f9 feat(TASK-677): promote hasCwdString type guard to shared/types/panels.ts
- 1e930c3 refactor(TASK-677): replace local hasCwdString copy in ipc/panels.ts with shared import
- f4911b9 refactor(TASK-677): migrate terminalPanelManager cwd-narrowing sites to shared guard
- c113b31 refactor(TASK-677): replace unsafe TerminalPanelState cast in TerminalPanel.tsx
- b525d54 test(TASK-677): add unit tests for hasCwdString guard (7 cases)
- c9087ec fix(TASK-677): replace null as any and no-explicit-any with as unknown as Parameters pattern
