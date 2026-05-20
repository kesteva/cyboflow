---
id: TASK-631
sprint: SPRINT-023
epic: crystal-cuts-and-rebrand
status: done
summary: "Dual-set CYBOFLOW_SESSION_ID + CRYSTAL_SESSION_ID (deprecated) in terminalSessionManager PTY env"
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-631 Done

5-line addition mirroring the canonical TASK-577 pattern in `terminalPanelManager.ts`: dual-set `CYBOFLOW_SESSION_ID` (canonical) and `CRYSTAL_SESSION_ID` (deprecated, with `@deprecated` + `TODO(post-v1)` comment) in the PTY spawn env block. No panel-ID variants — session-mode has no panel concept.

## Commits
- 0c3d914 feat(TASK-631): dual-set CYBOFLOW_SESSION_ID + CRYSTAL_SESSION_ID in PTY env block

## Verification
- Typecheck/lint: clean
- Verifier: APPROVED
- Code-reviewer: CLEAN
- Tests: not needed (plan-declared; mirrors TASK-577 precedent with no sibling test for terminalPanelManager)
