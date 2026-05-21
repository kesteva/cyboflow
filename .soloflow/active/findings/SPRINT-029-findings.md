---
sprint: SPRINT-029
pending_count: 2
last_updated: "2026-05-21T20:52:30.551Z"
---
# Findings Queue

## FIND-SPRINT-029-1
- **type:** bug
- **severity:** medium
- **source:** TASK-695 (verifier)
- **status:** open
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts:158
- **description:** Pre-existing test failure on main (base sha 28f8281): claudeCodeManager.killProcess.test.ts > killProcess mid-stream clears pipelines, sdkRuns, and processes maps times out at 5000ms (and the no-active-run case errors with TypeError: Cannot read properties of undefined (reading close) at db.close() in afterEach). Confirmed unrelated to TASK-695 — the test file was last touched by TASK-647 and is outside TASK-695s files_owned. The failure was masked from prior verifier runs because their executors did not run the full root test:unit suite. NOT a regression from this task.
- **suggested_action:** Spawn a follow-up task to diagnose and fix the killProcess test. Likely root cause is the db helper not returning a Database instance after a recent migration change, plus a teardown/timeout interaction with ApprovalRouter._resetForTesting. Recommend a small TASK in a future sprint.

## FIND-SPRINT-029-2
- **type:** improvement
- **severity:** low
- **source:** TASK-654 (verifier)
- **status:** open
- **location:** frontend/src/components/CreateSessionDialog.tsx:91, frontend/src/components/CreateSessionDialog.tsx:633, frontend/src/components/panels/cli/BaseCliPanel.tsx:425, main/src/events.ts:667, main/src/services/panels/claude/claudeCodeManager.ts:258
- **description:** TASK-654 added docs/CODE-PATTERNS.md § permissionMode contract Rule 5: Do NOT hardcode the string approve as a standalone fallback literal (|| approve). However, five || approve literal fallbacks remain in product code (4 in main/frontend product code, plus 1 in a regression-guard test that is documenting the legacy shape). These pre-date TASK-654 (introduced when TASK-569 flipped 15 camelCase callsites from ignore to approve without routing through a constant) and are not blocked by any TASK-654 acceptance criterion — but they contradict the contract Rule 5 the task itself just documented. The grep-gate sweep grep -rnE "\|\| .approve." would surface them as a follow-up cleanup pass.
- **suggested_action:** Schedule a small follow-up task to replace the five || approve literals with DEFAULT_PERMISSION_MODE imports, completing the doc-prescribed contract. Once landed, add the grep to the contracts verification block so future grep-gates catch new occurrences.
