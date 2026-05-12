---
sprint: SPRINT-002
pending_count: 4
last_updated: "2026-05-12T19:05:00Z"
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

## FIND-SPRINT-002-3
- **source:** TASK-558 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/components/panels/diff/MonacoDiffViewer.tsx:270,286,455
- **description:** TASK-558's completeness-gate sweep grep (`crystal[._-]` across main/src + frontend/src) returns three residual matches in MonacoDiffViewer.tsx that are NOT covered by the AC15 allowlist (`crystal-permissions` / `crystal-mcp-` / `crystalDirectory*` / `customCrystalDir` / `setCrystalDirectory` / `enableCrystalFooter`) and are NOT migration-fallback contexts. They are commented-out Monaco theme identifiers (`'crystal-dark'`, `'crystal-light'`) inside `handleBeforeMount` and a commented `useEffect`. They predate TASK-558 (verified via `git show 263cd69^:frontend/src/components/panels/diff/MonacoDiffViewer.tsx`) and the file is NOT in TASK-558's `files_owned`, so the executor had no scope to touch them. Not a TASK-558 failure but a sweep-allowlist gap: either the allowlist should explicitly call out `crystal-(dark|light)` (commented-out theme names) as deferred, or a follow-up house-cleaning task should rename the dead theme strings (and ideally delete the commented blocks) to keep the sweep grep clean for future identity-rebrand passes.
- **suggested_action:** Either (a) delete the commented-out `defineTheme('crystal-dark'/'crystal-light')` blocks and the commented `setTheme(... 'crystal-dark' ...)` line as unreachable Crystal-era dead code in a follow-up cleanup task, or (b) rename the strings to `cyboflow-(dark|light)` if a future Cyboflow theme registration is intended to replace them. Adding `crystal-(dark|light)` to a permanent allowlist is NOT recommended because they are unreferenced.
- **resolved_by:**

## FIND-SPRINT-002-4
- **source:** TASK-558 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** frontend/src — bare-word "Crystal" in user-facing copy
- **description:** TASK-558's identity-layer sweep targeted `crystal[._-]` (kebab/dot/underscore-prefixed identifiers) and explicitly enumerated 3 body-copy fixes (Welcome.tsx ×2, AnalyticsConsentDialog.tsx ×1). The bare-word `Crystal` (capitalized product name) survives in ~25 other user-visible strings the AC's regex couldn't catch, including: `frontend/src/App.tsx:296-297` (notification title `Crystal v${versionInfo.latest}` and body `'A new version of Crystal is available!'` — these fire after auto-update detection and are particularly visible), `frontend/src/components/UpdateDialog.tsx:185`, `frontend/src/components/Help.tsx:12,27,36,255`, `frontend/src/components/Settings.tsx:172,227,346,347,351,356,364,392,456,523,530,572,587,619,654`, `frontend/src/components/NotificationSettings.tsx:42,74,80,117`, `frontend/src/components/DiscordPopup.tsx:106,107,115`, `frontend/src/components/ProjectSelector.tsx:276,326`, `frontend/src/components/ProjectSettings.tsx:142,156,388`, `frontend/src/components/DraggableProjectTreeView.tsx:2549,2599`, `frontend/src/utils/performanceUtils.ts:1` (comment). App.tsx:296-297 is in TASK-558's `files_owned` but not called out in plan steps, so the executor correctly stayed in scope. AboutDialog.tsx:332 is intentional ("forked from Crystal (by Stravu)" attribution — leave). Until this is addressed users will see `Crystal` branding in notifications, Settings panel, Help dialog, and project tooltips even after the rebrand.
- **suggested_action:** Plan a follow-up task `IDEA-XXX: bare-word "Crystal" copy sweep` whose AC uses a bare-word regex (e.g. `\bCrystal\b` minus the AboutDialog attribution string) and a deferred-allowlist for legitimate Crystal references (the Stravu attribution, the `docs/crystal-legacy/` doc directory references, the `enableCrystalFooter` config field comment). Treat `App.tsx:296-297` as the highest-priority site (notification copy, fires automatically on version-check). Settings.tsx is the bulk of the work (~17 sites) and may need a Cyboflow logo reference and updated stravu.com utm_source param.
- **resolved_by:***
