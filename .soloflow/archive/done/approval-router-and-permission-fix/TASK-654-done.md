---
id: TASK-654
sprint: SPRINT-029
epic: approval-router-and-permission-fix
status: done
summary: "Complete permissionMode='ignore' sweep — new shared DEFAULT_PERMISSION_MODE constant; replaced 3 fallback sites; flipped 4 DEFAULT 'ignore' DDL clauses + legacy migration to 'approve'; added migration 008 (NULL backfill, idempotent); removed UI surfaces (BaseCliPanel dropdown, Settings radio); rewrote Playwright spec; documented contract in CODE-PATTERNS.md; regression test for getOrCreateMainRepoSession NULL→approve."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
visual_macos: skipped_user_preference
---

## Outcome
APPROVED + CLEAN. 565/566 main + 269/269 frontend pass. The 1 main failure (`claudeCodeManager.killProcess.test.ts`) is pre-existing on base branch (FIND-SPRINT-029-1), unrelated to TASK-654's files_owned.

## Files changed (13 commits)
- shared/types/permissionMode.ts (new)
- main/src/services/sessionManager.ts (|| fallback)
- main/src/database/database.ts (|| fallbacks + 4 DDL DEFAULTs)
- main/src/database/migrations/legacy/add_permission_mode.sql (grep-hygiene)
- main/src/database/migrations/008_permission_mode_approve_default.sql (new)
- frontend/src/components/panels/cli/BaseCliPanel.tsx (remove ignore option)
- frontend/src/components/Settings.tsx (remove ignore radio + narrow union)
- tests/permissions-ui-fixed.spec.ts (rewrite assertions)
- docs/CODE-PATTERNS.md (permissionMode contract section)
- main/src/services/__tests__/sessionManager.mainRepoPermission.test.ts (new)

## Findings emitted
- FIND-SPRINT-029-2: `|| 'approve'` literals exist contradicting contract Rule 5 — low severity follow-up.
