---
sprint: SPRINT-002
pending_count: 15
last_updated: "2026-05-12T20:43:15.153Z"
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
- **resolved_by:** *

## FIND-SPRINT-002-5
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** frontend/src/utils/migrateLocalStorageKey.test.ts:1-73
- **description:** New vitest spec added in TASK-558 (frontend/src/utils/migrateLocalStorageKey.test.ts) imports from `vitest`, but the frontend workspace has NO vitest install, NO vitest config, and NO `test` script in frontend/package.json. The file will never execute under `pnpm test` (root) which runs Playwright, nor under any per-workspace test command. The companion `frontend/src/utils/console.test.ts` was deleted in the same task, so the only frontend unit-test asset in the tree is now this orphaned, unrunnable spec.
- **suggested_action:** Pick one: (a) add vitest + jsdom devDeps and a `test` script + `vitest.config.ts` to frontend/, then wire it into root `pnpm test:unit` so the spec actually runs and protects the migration helper from future regressions; or (b) move migrateLocalStorageKey + its test into main/src/utils/ (which already has working vitest) and re-export from frontend; or (c) delete the spec and rely on manual QA. Option (a) is correct given the helper`s browser-only API surface (localStorage). Until resolved, the test file is documentation, not a test, and the localStorage migration logic regresses silently.
- **resolved_by:** 











Verification: `cat frontend/package.json` shows no vitest devDep and no `test` script; root `pnpm test` runs `playwright test`; the new spec`s `import { ..., vi } from "vitest"` will fail module resolution if anyone tries to run it.

Suspected tasks: TASK-558

## FIND-SPRINT-002-6
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** package.json:124-128
- **description:** `build.publish` still points at the upstream Crystal repo (`owner: stravu, repo: crystal`). The signed-build posture flipped on in TASK-053 plus the existing `release:mac` script (`electron-builder --publish always`) means the next signed release run will attempt to publish notarized cyboflow artifacts to github.com/stravu/crystal — either silently failing on auth (best case) or, if a `GH_TOKEN` for that repo is ever in scope, polluting an unrelated upstream project. This is a cross-task issue: TASK-053 enabled the production-publish path while TASK-558 left the publish target unbranded.
- **suggested_action:** Two changes, both high-priority before any signed release run: (1) update `build.publish` in package.json to the Cyboflow GitHub coordinates (`owner: cyboflow, repo: cyboflow` or whatever the actual repo is) — confirm with the user before flipping; (2) update `main/src/services/versionChecker.ts:40` to the same repo. If the Cyboflow GitHub org/repo does not exist yet, set `publish` to `null`/remove the field so `electron-builder --publish never` is the only path, and gate `release:mac` behind a TODO comment. Either way the current state ships Crystal-branded update metadata to end users.
- **resolved_by:** 










Evidence (package.json:124-128):
  "publish": {
    "provider": "github",
    "owner": "stravu",
    "repo": "crystal"
  }

Also: `main/src/services/versionChecker.ts:40` still polls `https://api.github.com/repos/stravu/crystal/releases/latest`, so in-app update checks return Crystal release metadata (not Cyboflow), which TASK-558 also missed.

Suspected tasks: TASK-053, TASK-558

## FIND-SPRINT-002-7
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** package.json:114 + scripts/configure-build.js:47
- **description:** Cross-task redundancy / dead config: TASK-053 sets `build.mac.notarize` to `{ "teamId": "${APPLE_TEAM_ID}" }` in package.json (line 114), but `scripts/configure-build.js` (which runs before every `build:mac*` and `release:mac*` invocation per package.json:33-41) unconditionally overwrites that field with a boolean: `packageJson.build.mac.notarize = canNotarize;` (configure-build.js:47). On the signed path the literal teamId object is never read; on the unsigned path it is overwritten to `false`. Net effect: the package.json value is dead, and the actual notarize teamId comes from the `APPLE_TEAM_ID` env var (which electron-builder picks up via its built-in notarize flow). Reading the package.json today gives a misleading impression that the teamId is hard-wired in source.
- **suggested_action:** Pick one canonical source-of-truth: (a) drop the `notarize` block from package.json entirely and let `configure-build.js` always write the field at build-time (cleaner — single writer); or (b) extend configure-build.js so when canNotarize is true it writes `{ teamId: process.env.APPLE_TEAM_ID }` instead of the bare boolean (matches the package.json shape and makes the literal meaningful for tools that read package.json directly, e.g. `electron-builder --publish never` invoked without configure-build.js). Pair with a one-line comment explaining the policy.
- **resolved_by:** 









Evidence:
  package.json:114 → "notarize": { "teamId": "${APPLE_TEAM_ID}" },
  configure-build.js:47 → packageJson.build.mac.notarize = canNotarize;

Suspected tasks: TASK-053 (introduced literal), TASK-053 left configure-build.js untouched.

## FIND-SPRINT-002-8
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/utils/console.ts:10 + frontend/src/App.tsx:60 + frontend/src/components/panels/editor/FileEditor.tsx:606 + frontend/src/components/panels/claude/RichOutputWithSidebar.tsx:43
- **description:** Cross-task pattern drift in the localStorage migration helper introduced by TASK-558. The helper `migrateLocalStorageKey` is invoked in four call sites but with two contradictory patterns:
- **suggested_action:** In console.ts, cache the verbose-logging value at module load (or first call) instead of re-reading per devLog invocation: `const verboseLogging = migrateLocalStorageKey("crystal.verboseLogging", "cyboflow.verboseLogging") === "true"; const isVerboseEnabled = () => verboseLogging;`. If runtime toggling is desired, expose a setter or window listener instead of polling localStorage on every log line. Optional: document the one-shot-vs-per-render contract in the helper`s JSDoc so future call sites pick the right pattern.
- **resolved_by:** 








1. ONE-SHOT mount-only (correct, per the helper`s docstring): App.tsx:58-61 (sidebar width) and FileEditor.tsx:604-606 (file tree width) — both wrap the call in `useEffect(..., [])` so it runs once per session.

2. PER-RENDER reads inside non-memoized closures (suspect): console.ts:9-12 wraps it in `isVerboseEnabled = () => migrateLocalStorageKey(...)`, called from every devLog.* / renderLog invocation. RichOutputWithSidebar.tsx:42-46 calls it inside `useState(() => ...)` initializer (acceptable — runs once per mount) but the legacy key is keyed by panel `id`, so each new panel re-runs the migration check.

The console.ts pattern means: every devLog call hits localStorage twice (getItem(newKey) + getItem(legacyKey) on cold path), and after the first migration each subsequent call still does getItem(newKey) — the migration is one-shot but the helper is invoked per-call. This is the exact issue the helper`s commit message claims to fix (`fix per-render migration`), yet console.ts is the one site that still pays the per-call cost. Memoizing the result (`let cachedVerbose: boolean | null = null;`) or caching at module load would avoid hundreds of localStorage hits per second in dev.

Suspected tasks: TASK-558

## FIND-SPRINT-002-9
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/utils/shellEscape.ts:25 + main/src/ipc/file.ts:238,277 + main/src/services/worktreeManager.ts:622 + main/src/services/commitManager.ts:102,211 + main/src/types/config.ts:53 + frontend/src/types/config.ts:40 + frontend/src/components/Settings.tsx:43,79,140,352
- **description:** TASK-558 was titled `finish Crystal→Cyboflow string sweep across identity layer` and the verifier`s code-reviewer follow-up (FIND-SPRINT-002-4) called out the bare-word `Crystal` regex gap. A second cross-task gap also remains: the config field `enableCrystalFooter` and its accompanying parameter/state names (`enableCrystalFooter`, `setEnableCrystalFooter`) are still Crystal-named everywhere — main/src/types/config.ts:53, frontend/src/types/config.ts:40, frontend/src/components/Settings.tsx:43+79+140+352, main/src/utils/shellEscape.ts:22+25+27, main/src/ipc/file.ts:238+241+277+279, main/src/services/worktreeManager.ts:621+625, main/src/services/commitManager.ts:102+105+211+212. Renaming this is a small but cross-cutting refactor (~13 sites including the SQLite preference key if `enableCrystalFooter` is persisted) and intersects FIND-SPRINT-002-4`s settings panel sweep. Worth batching with that follow-up so the Settings checkbox label, the config schema, and the shell-escape helper all flip together — otherwise the next pass will repeatedly walk the same files.
- **suggested_action:** Add to the bare-word `Crystal` follow-up task (already proposed in FIND-SPRINT-002-4`s suggested_action) an explicit AC: `rename enableCrystalFooter → enableCyboflowFooter across types/config.ts (both workspaces), Settings.tsx, shellEscape.ts, file.ts, worktreeManager.ts, commitManager.ts, plus migrate the persisted preference key (one-shot, mirroring the localStorage migration pattern from TASK-558). Update buildGitCommitCommand`s parameter name and JSDoc accordingly.` Also worth re-checking the `customCrystalDir` config field — TASK-558`s AC15 allowlist preserved it, but if Cyboflow is the long-term name then a future migration plan should be filed.
- **resolved_by:** 







Suspected tasks: TASK-558

## FIND-SPRINT-002-10
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/utils/shellEscape.ts:25-30 + main/src/ipc/file.ts:240-249,277-285 + main/src/services/worktreeManager.ts:621-630
- **description:** Cross-task duplication unchanged by SPRINT-002. The Cyboflow commit-message footer (`💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)\n\nCo-Authored-By: Cyboflow <hello@cyboflow.com>`) is hardcoded as a string literal in FOUR separate places: shellEscape.ts:27-30, file.ts:243-245 + 281-283 (two near-identical retry branches in the same function), and worktreeManager.ts:625-627. TASK-558 had to update all four sites in lockstep when flipping the rebrand, and the next change to the footer (e.g. URL fix per FIND-SPRINT-002-6, email change, tagline tweak) will require the same coordinated touch — and is one stale-string bug away from inconsistency. The same `enableCrystalFooter !== false` ternary pattern is also duplicated in all four sites.
- **suggested_action:** Extract a single `buildCommitFooter(enableFooter: boolean): string` helper in main/src/utils/shellEscape.ts (or a new commitFooter.ts) and replace the four hardcoded blocks with calls. Bonus: the file.ts retry branch at 277-285 is a near-verbatim copy of 240-249 — extract a `buildCommitMessage(request, config)` helper to fold both. This shrinks the next rebrand-or-URL-fix to a single edit and removes a recurring hot spot for inconsistency bugs.
- **resolved_by:** 






Suspected tasks: TASK-558 (touched all four), pre-existing duplication

## FIND-SPRINT-002-11
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/index.ts:225-490
- **description:** main/src/index.ts contains 6 near-identical 12-line blocks (lines ~225-243, ~261-275, ~322-337, ~378-393, ~424-439, ~466-480, ~640-655) that all do the same thing: format a `[timestamp] [SOURCE LEVEL] message` line and `fs.appendFileSync(cyboflow-backend-debug.log or cyboflow-frontend-debug.log, ...)`. TASK-558 had to change `crystal-*-debug.log` → `cyboflow-*-debug.log` in 8 separate locations (verified via the diff). This is exactly the kind of cross-task pattern that a per-task code reviewer cannot see — the next rebrand pass, the next log-format change, or the next attempt to add log rotation will have to walk all 8 sites again.
- **suggested_action:** Extract a `getDevDebugLogPath(stream: "frontend" | "backend"): string` helper plus `appendDevDebugLog(stream, level, message)` that the 6 console hooks call. Two changes, one canonical path, future rebrand is a one-line edit. Optional: lift the appendFileSync into a tiny ring-buffer to avoid sync I/O on every console.log in dev (current code does sync writes on every line — visible in profile flame graphs as ~5% of dev startup).
- **resolved_by:** 





Suspected tasks: TASK-558 (touched all 8), pre-existing

## FIND-SPRINT-002-12
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** build/afterSign.test.js + scripts/configure-build.test.js
- **description:** Cross-task convention drift in test framework choice. SPRINT-002 added two new test files in the build/scripts layer:
- **suggested_action:** Decide on a single unit-test runtime and wire it into `pnpm test:unit`. Vitest works fine for plain CommonJS files (build/afterSign.js, scripts/configure-build.js) — see vitest`s `environment: "node"` config. Either: (a) port both new build/scripts tests to vitest (small effort, ~30 lines each, and they get parallel execution + better diff output), or (b) at minimum add an `npm run test:build-scripts` that runs `node build/afterSign.test.js && node scripts/configure-build.test.js` and call it from CI. Today these tests run only when a human remembers to invoke them, which means they protect against zero regressions in practice.
- **resolved_by:** 



- build/afterSign.test.js — vanilla node script with a hand-rolled `assert(condition, message)` helper, run via `node build/afterSign.test.js`
- scripts/configure-build.test.js — also vanilla node script, also hand-rolled `assert()`, also `process.exit(failed ? 1 : 0)`

Meanwhile, main/ uses vitest (main/src/utils/crystalDirectory.test.ts, main/src/services/__tests__/...test.ts), and TASK-558 added a vitest spec in frontend/ (FIND-SPRINT-002-5). The build/ + scripts/ layer now has its own third convention. Neither is wired into `pnpm test` (which runs Playwright); both must be invoked manually. After SPRINT-002 the repo has THREE distinct unit-test runtimes (vitest in main, vitest-but-orphaned in frontend, hand-rolled node-asserts in build/+scripts) with zero CI integration for any of them.

Suspected tasks: TASK-053 (configure-build.test.js), TASK-054 (afterSign.test.js)

## FIND-SPRINT-002-13
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** build/entitlements.mac.plist:20-22
- **description:** Cross-task hygiene: the entitlements file added in TASK-052 includes `com.apple.security.files.user-selected.read-write` with an inline comment that explicitly admits it is a `forward-compat placeholder: sandbox-only entitlement, no runtime effect without com.apple.security.app-sandbox`. Cyboflow does NOT have `com.apple.security.app-sandbox` set, so this entitlement is signed into the binary but does nothing. Apple`s notarization process succeeds either way, but minimum-permissions hygiene says: don`t request entitlements you don`t use. The comment cites IDEA-002 slice 3 as the rationale but that idea/slice is not in the active backlog under that ID (verified: no docs reference IDEA-002 anywhere reachable from the changed surface).
- **suggested_action:** Drop the `com.apple.security.files.user-selected.read-write` line until app-sandbox is actually enabled (which itself is a non-trivial migration — node-pty + better-sqlite3 + git CLI invocations all need extension grants under sandbox). Add a short comment in the plist or in docs/signing/APPLE_DEVELOPER_SETUP.md noting `re-add this entitlement when enabling com.apple.security.app-sandbox`. If the IDEA-002 reference is meaningful, link to the actual idea file path so future maintainers can find the rationale.
- **resolved_by:** 



Suspected tasks: TASK-052

## FIND-SPRINT-002-14
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/database.ts:3 + main/src/services/configManager.ts:6 + main/src/utils/crystalDirectory.test.ts (file) + main/src/services/mcpPermissionBridge.ts:94 + main/src/services/permissionIpcServer.ts:35 + main/src/services/panels/claude/claudeCodeManager.ts:148,732,806 + main/src/services/mcpPermissionServer.ts:18
- **description:** Out-of-scope observation, surfaced for next compound: the `crystalDirectory` module (main/src/utils/crystalDirectory.{ts,test.ts}) and the `crystal-permissions` MCP server name (mcpPermissionServer.ts:18, mcpPermissionBridge.ts:94, claudeCodeManager.ts:148+806) are still Crystal-named everywhere. These were intentionally outside TASK-558`s identity-layer sweep (and outside any task in SPRINT-002`s files_owned), but together with FIND-SPRINT-002-4 (bare-word Crystal copy) and FIND-SPRINT-002-9 (enableCrystalFooter rename) they form the third bucket of rebrand work: identifier renames in main/src that change runtime behavior (the MCP server name appears in CLI args passed to `claude` and in temp file paths). A future renaming task needs to coordinate (a) the in-process server registration name, (b) the temp file path glob, (c) any persisted socket/state references on user machines, and (d) any docs referring to the MCP tool name.
- **suggested_action:** File a follow-up task `IDEA-XXX: rename Crystal-prefixed runtime identifiers (crystalDirectory module + crystal-permissions MCP)` with two phases: phase 1 introduces aliasing (the new name + a deprecation shim for the old name, mirroring the --crystal-dir CLI flag handling in main/src/index.ts:114-128) so existing user installs keep working; phase 2 (next major) drops the alias. Coordinate with FIND-SPRINT-002-4 and FIND-SPRINT-002-9 in the same sprint so the rebrand walks each file once.
- **resolved_by:** 


Suspected tasks: out-of-scope (none in SPRINT-002 owned these files)

## FIND-SPRINT-002-15
- **source:** SPRINT-002 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** CLAUDE.md
- **description:** CLAUDE.md gap: SPRINT-002 introduced two cross-cutting conventions that future agents need to know about but aren`t documented:

(1) localStorage migration pattern. TASK-558 added `frontend/src/utils/migrateLocalStorageKey.ts` as the canonical helper for one-shot Crystal→Cyboflow key migrations, with FOUR active call sites across App.tsx, FileEditor.tsx, RichOutputWithSidebar.tsx, and console.ts. There is no doc telling future agents to use this helper instead of hand-rolled localStorage.getItem/setItem when introducing a new namespaced key — they will rediscover the migration pattern from scratch the next time a key is renamed.

(2) Build signing posture toggle. TASK-053 introduced the `CSC_DISABLE=true` escape hatch to skip signing locally + the `configure-build.js` env-var contract (CSC_LINK + APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD all required). docs/signing/APPLE_DEVELOPER_SETUP.md covers the provisioning side beautifully but does not appear in CLAUDE.md`s `Reference Docs` list, so an agent doing a build-related task won`t know to load it.

Suspected tasks: TASK-558 (migration helper), TASK-051+053 (signing docs)
- **suggested_action:** Two tiny CLAUDE.md edits: (a) add `docs/signing/APPLE_DEVELOPER_SETUP.md — Apple signing/notarization env-var contract and provisioning steps` to the Reference Docs list near the top; (b) add a short `## localStorage Migration` section pointing to `frontend/src/utils/migrateLocalStorageKey.ts` with a one-line `use this helper for any new Crystal→Cyboflow key rename` instruction. Both <5 lines total. Defer to compound-skeptic to decide if the prune-CLAUDE.md guard makes either entry unwelcome.
- **resolved_by:** 
