---
sprint: SPRINT-002
pending_count: 2
last_updated: "2026-05-12T18:25:07Z"
---

# Findings Queue

SPRINT-002 started with missing infra: peekaboo, playwright; tests deferred.
TASK-055 gated: failing blocking prereq (signing env vars not exported; depends on TASK-053 signed-posture flip).
TASK-056 gated: failing blocking prereq (signed DMG artifact does not exist yet; depends on TASK-055).
TASK-055/056 unblocked mid-sprint: user confirmed Apple Developer Program enrollment, Developer ID cert, and AC_PASSWORD notarytool profile are provisioned (verifier confirmed live in TASK-051 round). Tasks restored to pending; will run in serial order after TASK-002/053.
TASK-055 re-blocked at run: APPLE_ID/APPLE_TEAM_ID/APPLE_APP_SPECIFIC_PASSWORD/CSC_LINK/CSC_KEY_PASSWORD not exported in the shell where /soloflow:sprint is running. AC_PASSWORD keychain profile is in place; the gap is shell env vars only. User can re-invoke /soloflow:sprint TASK-055 after exporting. TASK-056 re-blocked transitively.

## FIND-SPRINT-002-2
- **source:** TASK-557 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** .soloflow/active/findings/SPRINT-001-findings.md
- **description:** TASK-557's executor logged FIND-SPRINT-001-1 into SPRINT-001-findings.md, but the active sprint at the time of TASK-557 execution is SPRINT-002 (per .soloflow/active/sprints/SPRINT-002/sprint.json). The executor agent prompt likely resolved the sprint id from a stale or incorrect source. Findings written to a non-active sprint file may be overlooked by the compounder when the active sprint closes.
- **suggested_action:** Audit the executor agent prompt's resolution of `{sprint.id}` for the findings file path. Should read from `.soloflow/sprint.json` or the active-sprint manifest at write time, not from a cached/historical value.
- **resolved_by:**

## FIND-SPRINT-002-1
- **source:** TASK-053 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** scripts/configure-build.test.js:44-94
- **description:** `runCase` builds a `keysToDelete` array (lines 44, 60-62) that is never read — the restore loop on lines 87-89 unconditionally deletes every key in `signingKeys` before re-applying `savedEnv`, making the tracked list dead bookkeeping. Separately, the outer `try/catch` blocks (lines 112-120, 145-151) re-attempt the snapshot restore as "belt+suspenders", but `runCase`'s own `finally` runs before exceptions propagate, so the outer `existsSync(PACKAGE_BAK)` branch is unreachable in normal operation. Both are cosmetic in a smoke test that already passes cleanly and restores the tree; flagging here so a future pass can simplify if/when the test grows additional cases.
- **suggested_action:** Drop `keysToDelete` and its comment, and either remove the outer per-case `try/catch` (let exceptions bubble to a single top-level handler) or document the redundant restore as defense against `runCase` being mutated later.
- **resolved_by:**
