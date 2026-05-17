---
id: TASK-577
sprint: SPRINT-014
epic: crystal-cuts-and-rebrand
status: done
summary: "Dual-set CYBOFLOW_SESSION_ID/CYBOFLOW_PANEL_ID alongside legacy CRYSTAL_* in terminalPanelManager PTY env block; deprecation comment on legacy pair."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-577 — Done

Added canonical `CYBOFLOW_SESSION_ID` / `CYBOFLOW_PANEL_ID` env vars to `main/src/services/terminalPanelManager.ts` PTY spawn block, preserving legacy `CRYSTAL_*` pair under `@deprecated TODO(post-v1)` comment. Mirrors the `--crystal-dir` CLI deprecation pattern.

## Verification

- All 4 ACs MET via grep.
- Main typecheck exit 0.
- Verifier APPROVED_WITH_DEFERRED (deferred check = pre-existing better-sqlite3 ABI issue, not introduced by this task).
- Code reviewer CLEAN.

## Findings

- New: FIND-SPRINT-014-16 (better-sqlite3 ABI deferred check queued to human-review-queue with dedup_key)

## Commits

- `ae78e34` feat(TASK-577): dual-set CYBOFLOW_SESSION_ID/CYBOFLOW_PANEL_ID alongside legacy CRYSTAL_* env vars
