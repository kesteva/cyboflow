---
id: TASK-628
sprint: SPRINT-023
epic: crystal-cuts-and-rebrand
status: done
summary: "Consolidate commit-footer lookup + composition into commitFooter.ts (isCommitFooterEnabled + appendCommitFooter)"
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-628 Done

Added `isCommitFooterEnabled(configManager)` and `appendCommitFooter(message, configManager)` helpers in `main/src/utils/commitFooter.ts` (default-on, opt-out via `enableCyboflowFooter: false`). All 5 inline-lookup/composition sites across `ipc/file.ts`, `ipc/git.ts`, `services/worktreeManager.ts`, `services/commitManager.ts`, and `utils/shellEscape.ts` collapsed to use the helpers. Byte-equal composition preserved via the existing `buildCommitFooter` literal.

## Commits
- 9a2b4dd feat(TASK-628): consolidate commit-footer lookup/composition into commitFooter.ts

## Verification
- Tests: 8 commitFooter tests pass
- Typecheck/lint: clean
- Verifier: APPROVED
- Code-reviewer: CLEAN
