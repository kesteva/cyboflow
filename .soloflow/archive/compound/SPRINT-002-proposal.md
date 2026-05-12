---
sprints: [SPRINT-002]
span_label: SPRINT-002
created: 2026-05-12T00:00:00Z
counters_start:
  ideas: 13
summary:
  cleanups: 4
  backlog_tasks: 7
  claude_md: 4
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-002

## A. Clean-up items (execute now)

### A1. Delete commented-out `crystal-dark` / `crystal-light` Monaco theme blocks
- **Summary:** Remove three commented-out Crystal-branded Monaco theme strings from `MonacoDiffViewer.tsx` that were missed by the identity sweep and are permanently unreachable dead code.
- **Source-Sprint:** SPRINT-002
- **Rationale:** `handleBeforeMount` in `MonacoDiffViewer.tsx` contains a fully commented-out `defineTheme('crystal-dark', ...)` block (lines 270–284), a `defineTheme('crystal-light', ...)` block (lines 286–300), and a commented `setTheme(... 'crystal-dark' ...)` call. The theme registrations are never re-enabled (no active call site), they predate TASK-558, and FIND-SPRINT-002-3 confirmed they are not covered by TASK-558's AC15 allowlist. Deleting them removes the only remaining Crystal-brand strings in that file and keeps the identity-sweep grep (`crystal[._-]`) clean for future passes.
- **Blast radius:** `frontend/src/components/panels/diff/MonacoDiffViewer.tsx` lines 268–301; cosmetic deletion, zero runtime effect; risk: **trivial**.
- **Source:** FIND-SPRINT-002-3 (TASK-558 verifier); confirmed pre-existing via `git show 263cd69^` check noted in the finding.
- **Proposed change:**
  Delete lines 267–301 in `frontend/src/components/panels/diff/MonacoDiffViewer.tsx` — the entire `handleBeforeMount` callback body (the commented-out `defineTheme('crystal-dark', ...)` block, the `defineTheme('crystal-light', ...)` block, and their surrounding comments). Also remove the `onBeforeMount={handleBeforeMount}` prop from the `<MonacoDiffEditor>` JSX if `handleBeforeMount` becomes empty. Optionally leave a one-line comment:
  ```
  // Custom Monaco themes (crystal-dark/crystal-light) removed — re-add as
  // cyboflow-dark/cyboflow-light if a custom theme is introduced.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `frontend/src/components/panels/diff/MonacoDiffViewer.tsx:267-301` — the `handleBeforeMount` callback body is entirely commented-out `defineTheme('crystal-dark'/'crystal-light')` blocks with no live calls; `beforeMount={handleBeforeMount}` at line 743 is the only consumer, so deleting the callback body (or removing the prop) is a trivial isolated cleanup.

### A2. Fix `build.publish` in `package.json` — still points at upstream Crystal repo
- **Summary:** Update `package.json`'s `build.publish` block and `versionChecker.ts` to point at the Cyboflow GitHub repository so the next signed release does not attempt to publish to `stravu/crystal` or fetch Crystal release metadata for in-app update checks.
- **Source-Sprint:** SPRINT-002
- **Rationale:** FIND-SPRINT-002-6 (sprint-code-reviewer): `package.json:124–128` still has `"owner": "stravu", "repo": "crystal"`. With TASK-053 flipping `build.mac.hardenedRuntime` to `true` and the existing `release:mac` script using `electron-builder --publish always`, the next signed-release invocation will attempt to push notarized cyboflow artifacts to `github.com/stravu/crystal`. Separately, `main/src/services/versionChecker.ts:40` polls `https://api.github.com/repos/stravu/crystal/releases/latest`, so in-app update notifications show Crystal version metadata. Both must be corrected before any signed release run.
- **Blast radius:** `package.json` lines 124–128; `main/src/services/versionChecker.ts` line 40; risk: **low** (confirm the correct Cyboflow GitHub org/repo with the user before applying; if no Cyboflow GitHub repo exists yet, remove the `publish` block and add a TODO comment so `electron-builder --publish never` is the safe default).
- **Source:** FIND-SPRINT-002-6 (sprint-code-reviewer); evidence: `package.json:124–128` (`"owner": "stravu", "repo": "crystal"`); `versionChecker.ts:40` (`https://api.github.com/repos/stravu/crystal/releases/latest`) — confirmed by direct file read.
- **Proposed change:**
  ```diff
  // package.json:124-128
  -    "publish": {
  -      "provider": "github",
  -      "owner": "stravu",
  -      "repo": "crystal"
  -    }
  +    "publish": {
  +      "provider": "github",
  +      "owner": "<cyboflow-github-org>",
  +      "repo": "<cyboflow-github-repo>"
  +    }
  
  // main/src/services/versionChecker.ts:40
  -      const response = await fetch('https://api.github.com/repos/stravu/crystal/releases/latest');
  +      const response = await fetch('https://api.github.com/repos/<cyboflow-github-org>/<cyboflow-github-repo>/releases/latest');
  ```
  If the GitHub org/repo does not exist yet: remove the `publish` block and add a comment:
  ```
  // TODO: restore publish block once cyboflow GitHub repo is created.
  // Until then, use electron-builder --publish never for all release runs.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified `package.json:124-128` still hardcodes `"owner": "stravu", "repo": "crystal"` and `main/src/services/versionChecker.ts:40` polls the same upstream — concrete pre-release blocker since `release:mac` uses `electron-builder --publish always` and would mis-publish notarized cyboflow artifacts.

### A3. Drop the inert `com.apple.security.files.user-selected.read-write` entitlement
- **Summary:** Remove the sandbox-only entitlement from `build/entitlements.mac.plist` that is signed into every binary but has no runtime effect without `com.apple.security.app-sandbox`, which Cyboflow does not enable.
- **Source-Sprint:** SPRINT-002
- **Rationale:** FIND-SPRINT-002-13 (sprint-code-reviewer): `build/entitlements.mac.plist:20–22` includes `com.apple.security.files.user-selected.read-write` with an inline comment admitting it is a "forward-compat placeholder: sandbox-only entitlement, no runtime effect without `com.apple.security.app-sandbox`". Cyboflow does not set `app-sandbox`, so the entitlement is dead weight that violates minimum-permissions hygiene. The IDEA-002 rationale cited in the comment was not found at any reachable path (no `docs/` file references IDEA-002). Dropping it reduces the signed binary's entitlement surface and eliminates the misleading comment.
- **Blast radius:** `build/entitlements.mac.plist` lines 20–22; risk: **trivial** (entitlement is confirmed inert without `app-sandbox` as stated in the inline comment and TASK-052-done.md).
- **Source:** FIND-SPRINT-002-13 (sprint-code-reviewer); TASK-052-done.md ("Kept (forward-compat placeholder): `com.apple.security.files.user-selected.read-write` — sandbox-only entitlement, inert without `app-sandbox`").
- **Proposed change:**
  ```diff
  // build/entitlements.mac.plist
  -    <!-- forward-compat placeholder: sandbox-only entitlement, no runtime effect without com.apple.security.app-sandbox. Listed in IDEA-002 slice 3 as required; retained pending future sandbox decision in v2. -->
  -    <key>com.apple.security.files.user-selected.read-write</key>
  -    <true/>
  +    <!-- com.apple.security.files.user-selected.read-write omitted: sandbox-only, no effect
  +         without com.apple.security.app-sandbox. Re-add when enabling the app sandbox
  +         (node-pty, better-sqlite3, and git CLI invocations all need extension grants —
  +         non-trivial migration). -->
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed at `build/entitlements.mac.plist:20-22` — entitlement is signed but inert without `app-sandbox` (which the plist does not set), and IDEA-002 slice 3 is the only origin claim (verified at `.soloflow/active/ideas/IDEA-002.md:17`), so removing it tightens entitlement surface with no runtime impact.
- **Counterfactual:** If a near-term plan introduces `com.apple.security.app-sandbox`, retain the entitlement to avoid two-step churn.

### A4. Simplify dead bookkeeping in `scripts/configure-build.test.js`
- **Summary:** Remove the dead `keysToDelete` array and its associated comment from the configure-build smoke test, which is built but never consumed by the restore loop.
- **Source-Sprint:** SPRINT-002
- **Rationale:** FIND-SPRINT-002-1 (TASK-053 code-reviewer): `scripts/configure-build.test.js:44–62` builds a `keysToDelete` array that is never consumed — the restore loop on lines 87–89 unconditionally deletes every key in `signingKeys` regardless. Separately, the outer `try/catch` blocks (lines 112–120, 145–151) duplicate a restore that `runCase`'s own `finally` already handles; those branches are unreachable in normal operation. The test passes cleanly; this tidy prevents confusion when the test grows additional cases.
- **Blast radius:** `scripts/configure-build.test.js` lines 44, 60–62, 87–89, 112–120, 145–151; risk: **trivial** (smoke test only, no production code touched).
- **Source:** FIND-SPRINT-002-1 (TASK-053 code-reviewer); TASK-053-done.md ("Code-reviewer queued one low-severity cleanup finding: dead `keysToDelete` array and redundant outer try/catch. Cosmetic, not blocking.").
- **Proposed change:**
  Delete the `const keysToDelete: string[] = []` declaration (line 44) and the two `.push(k)` calls in lines 60–62. The restore loop on lines 87–89 already correctly unconditionally deletes all `signingKeys` keys. For the outer `try/catch` blocks: either remove them (let exceptions bubble to a single top-level handler) or add a one-line comment: `// Belt-and-suspenders restore if runCase's finally is removed in future.`

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `scripts/configure-build.test.js:44,60-62,87-89` — `keysToDelete` array is populated but never read; the restore loop unconditionally deletes every `signingKeys` entry, making the tracking dead bookkeeping; trivial isolated cleanup in a smoke test.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Bare-word "Crystal" copy sweep across frontend user-facing strings
- **Summary:** Replace all remaining bare-word "Crystal" brand references across the frontend with "Cyboflow" — approximately 25 sites including notification copy, Settings panel, Help dialog, and project tooltips.
- **Source-Sprint:** SPRINT-002
- **Source:** FIND-SPRINT-002-4 (TASK-558 code-reviewer); TASK-558-done.md.
- **Problem:** TASK-558's identity sweep targeted `crystal[._-]` (kebab/dot/underscore identifiers) and caught 3 body-copy sites. The bare-word capitalized product name `Crystal` was not caught by that regex and survives in approximately 25 user-visible strings. The highest-priority site is `frontend/src/App.tsx:296–297` (auto-update notification title `"Crystal v${versionInfo.latest}"` and body `"A new version of Crystal is available!"` — these fire automatically on version check). Further impacted files: `frontend/src/components/UpdateDialog.tsx:185`, `frontend/src/components/Help.tsx:12,27,36,255`, `frontend/src/components/Settings.tsx:172,227,346,347,351,356,364,392,456,523,530,572,587,619,654` (~17 sites), `frontend/src/components/NotificationSettings.tsx:42,74,80,117`, `frontend/src/components/DiscordPopup.tsx:106,107,115`, `frontend/src/components/ProjectSelector.tsx:276,326`, `frontend/src/components/ProjectSettings.tsx:142,156,388`, `frontend/src/components/DraggableProjectTreeView.tsx:2549,2599`, `frontend/src/utils/performanceUtils.ts:1` (comment). Acceptable exemptions: `AboutDialog.tsx:332` ("forked from Crystal (by Stravu)" attribution — preserve), all `docs/crystal-legacy/` references.
- **Proposed direction:** Create a task whose AC uses a `\bCrystal\b` regex sweep across `frontend/src/` (excluding the `AboutDialog.tsx` attribution and `docs/crystal-legacy/`). The task should: (1) replace all notification/UI copy with "Cyboflow"; (2) check `Settings.tsx` for any Stravu `utm_source` parameter that should be updated; (3) verify `DiscordPopup.tsx` invite link points to the Cyboflow server, not Crystal's. Batch with B2 (`enableCrystalFooter` rename) and B3 (`crystal-permissions` MCP rename) so all frontend + config-schema files are walked once per sprint rather than repeatedly.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms 25+ bare-word "Crystal" sites in user-visible copy (notification title at `frontend/src/App.tsx:292-293`, Settings.tsx Attribution/About panels, NotificationSettings tooltips); these fire automatically on auto-update and remain Crystal-branded for end users despite IDEA-001 slice 7's rebrand claim.
- **Counterfactual:** If IDEA-001's rebrand slice (currently `status: draft`) is refined to explicitly own the bare-word copy sweep, this becomes redundant with that idea's expansion.

### B2. Rename `enableCrystalFooter` → `enableCyboflowFooter` across config schema and all call sites
- **Summary:** Rename the Crystal-branded `enableCrystalFooter` config field to `enableCyboflowFooter` across both `types/config.ts` files, `Settings.tsx`, `shellEscape.ts`, `file.ts`, `worktreeManager.ts`, `commitManager.ts`, and the persisted preference key with a one-shot migration.
- **Source-Sprint:** SPRINT-002
- **Source:** FIND-SPRINT-002-9 (sprint-code-reviewer); TASK-558-done.md (explicitly deferred: "renaming requires config migration").
- **Problem:** `enableCrystalFooter` and its state name `setEnableCrystalFooter` survive in approximately 13 sites: `main/src/types/config.ts:53`, `frontend/src/types/config.ts:40`, `frontend/src/components/Settings.tsx:43,79,140,352`, `main/src/utils/shellEscape.ts:22,25,27`, `main/src/ipc/file.ts:238,241,277,279`, `main/src/services/worktreeManager.ts:621,625`, `main/src/services/commitManager.ts:102,105,211,212`. If the persisted preference key in the SQLite database is also `enableCrystalFooter`, a migration step is required. `customCrystalDir` also remains on the TASK-558 AC15 allowlist and should be tracked for a future migration plan.
- **Proposed direction:** Follow the same one-shot migration approach TASK-558 used for localStorage keys: introduce an `enableCyboflowFooter` field in both config type schemas, add a one-time migration that reads the old DB key and writes the new one (mirroring the `migrateLocalStorageKey` helper pattern), then rename all consumer sites in a single commit. The task AC should verify: (a) `grep -r enableCrystalFooter main/src frontend/src` returns zero matches after the rename, (b) an existing `enableCrystalFooter=true` DB row is read correctly by the migrated code, (c) typecheck passes. Coordinate with B1 (bare-word Crystal sweep) so both tasks walk `Settings.tsx` in the same sprint.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed 13 `enableCrystalFooter` sites across `main/src/types/config.ts:53`, `frontend/src/types/config.ts:40`, `Settings.tsx`, `shellEscape.ts`, `file.ts`, `worktreeManager.ts`, `commitManager.ts`; TASK-558 explicitly deferred this because of the config migration cost, and the surface is bounded enough for a single small task.
- **Counterfactual:** If config persistence proves to be only in-memory (no DB row to migrate), the migration step collapses and this is closer to a B-A cleanup.

### B3. Rename Crystal-prefixed runtime identifiers: `crystalDirectory` module and `crystal-permissions` MCP server name
- **Summary:** Rename the `crystalDirectory` module and the `crystal-permissions` MCP server registration name to Cyboflow equivalents, with a backward-compat deprecation shim for existing user installs.
- **Source-Sprint:** SPRINT-002
- **Source:** FIND-SPRINT-002-14 (sprint-code-reviewer); TASK-558-done.md.
- **Problem:** `main/src/utils/crystalDirectory.{ts,test.ts}` and the `crystal-permissions` MCP server name (`mcpPermissionServer.ts:18`, `mcpPermissionBridge.ts:94`, `claudeCodeManager.ts:148,806`) are runtime-visible: the MCP server name appears in CLI arguments passed to `claude` and in temp file paths. Sites affected: `main/src/services/database.ts:3`, `main/src/services/configManager.ts:6`, `main/src/utils/crystalDirectory.test.ts` (filename), `main/src/services/mcpPermissionBridge.ts:94`, `main/src/services/permissionIpcServer.ts:35`, `main/src/services/panels/claude/claudeCodeManager.ts:148,732,806`, `main/src/services/mcpPermissionServer.ts:18`. A rename without aliasing breaks existing user installs that have `crystal-permissions` in their Claude configuration.
- **Proposed direction:** Two-phase approach: Phase 1 (this task) introduces aliasing — register `cyboflow-permissions` as the canonical MCP server name and keep `crystal-permissions` as a deprecated alias with a warning log; rename the TypeScript module to `cyboflowDirectory.ts` and add a re-export shim from the old path. Phase 2 (next major version) removes the alias. The `--crystal-dir` CLI flag handling in `main/src/index.ts:114–128` is the template for the backward-compat aliasing pattern. Coordinate with B1 and B2 so all shared files are walked once per sprint.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `crystalDirectory` module (10 import sites including `main/src/services/database.ts:3`, `configManager.ts:6`, `claudeCodeManager.ts:12`) and `crystal-permissions` MCP name (`mcpPermissionServer.ts:18`, `mcpPermissionBridge.ts:94`, `claudeCodeManager.ts:148,806`, `permissionIpcServer.ts:35`) are runtime-visible (CLI args, socket paths) — aliasing is the right shape given existing installs.
- **Counterfactual:** If there are no existing user installs of cyboflow yet (the app is pre-release), the alias shim is unnecessary churn and a direct rename suffices.

### B4. Wire the frontend vitest workspace so `migrateLocalStorageKey.test.ts` actually runs
- **Summary:** Add vitest and jsdom to the `frontend/` workspace and wire a `test:unit` script into the root `pnpm` suite so the existing `migrateLocalStorageKey.test.ts` actually executes on CI.
- **Source-Sprint:** SPRINT-002
- **Source:** FIND-SPRINT-002-5 (sprint-code-reviewer); TASK-558-done.md.
- **Problem:** `frontend/src/utils/migrateLocalStorageKey.test.ts` was added in TASK-558 and imports from `vitest`, but `frontend/package.json` has no vitest devDep and no `test` script. The spec never runs under `pnpm test` (Playwright only) and would fail module resolution if anyone attempted `pnpm --filter frontend test`. The localStorage migration logic (`migrateLocalStorageKey.ts`) is a cross-cutting helper used in four call sites; without a running test suite, regressions there are silent. Confirmed by reading `frontend/package.json` — no vitest entry.
- **Proposed direction:** Add `vitest`, `@vitest/ui`, and `jsdom` to `frontend/package.json` devDependencies. Create `frontend/vitest.config.ts` with `environment: "jsdom"`. Add a `"test": "vitest run"` script to `frontend/package.json`. Add `pnpm --filter frontend test` to a new root-level `pnpm test:unit` script. Verify the 4 existing test cases in `migrateLocalStorageKey.test.ts` pass. The browser-only API surface (`localStorage`) makes jsdom the correct environment (option (a) from FIND-SPRINT-002-5's suggested_action).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `frontend/package.json` has no vitest devDep and no `test` script, yet `frontend/src/utils/migrateLocalStorageKey.test.ts` imports from `vitest` and uses `vi.stubGlobal('localStorage', ...)` — the spec is unrunnable and protects 4 active call sites of a helper that already silently regressed once (per FIND-SPRINT-002-8's per-render anti-pattern).

### B5. Unify build/scripts layer unit tests: add CI wiring for `afterSign.test.js` and `configure-build.test.js`
- **Summary:** Wire `build/afterSign.test.js` and `scripts/configure-build.test.js` into a root `pnpm test:build` script and include it in a `pnpm test:unit` suite so they are not silently skipped on every automated run.
- **Source-Sprint:** SPRINT-002
- **Source:** FIND-SPRINT-002-12 (sprint-code-reviewer); TASK-054-done.md; TASK-053-done.md.
- **Problem:** SPRINT-002 added two plain-Node smoke tests (`build/afterSign.test.js`, `scripts/configure-build.test.js`). Neither is invoked by `pnpm test` (Playwright), `pnpm --filter main test` (vitest), or any other automated hook. After SPRINT-002 the repo has three distinct unit-test runtimes (vitest in `main/`, vitest-orphaned in `frontend/`, hand-rolled node-asserts in `build/`+`scripts/`) with zero CI integration for any of them. The build/scripts tests are particularly valuable because they guard the signing-posture toggle logic introduced by TASK-053.
- **Proposed direction:** (1) Add a `"test:build": "node build/afterSign.test.js && node scripts/configure-build.test.js"` script to root `package.json`. (2) Add a `"test:unit"` root script that runs `pnpm --filter main test && pnpm --filter frontend test && pnpm run test:build`. (3) Optionally port the two hand-rolled node tests to vitest (small effort, ~30 lines each, better diffs) — this reduces the three-runtime proliferation to one. The primary goal is that `pnpm test:unit` runs all unit-test tiers automatically.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed root `package.json:48` `"test": "playwright test"` and main workspace `"test": "vitest"` (main/package.json:14), but `build/afterSign.test.js` and `scripts/configure-build.test.js` are invoked by no script — they guard the signing-posture toggle logic that gates every signed release, so silent skipping is non-cosmetic.
- **Counterfactual:** If the team intends signed releases to be a manual checklist with explicit pre-flight test invocation, CI wiring is unnecessary process overhead.

### B6. Extract `buildCommitFooter` helper to eliminate four hardcoded Cyboflow footer string literals
- **Summary:** Extract a `buildCommitFooter(enableFooter: boolean): string` helper to replace four near-identical hardcoded commit-footer string literals in `shellEscape.ts`, `file.ts` (two branches), and `worktreeManager.ts`.
- **Source-Sprint:** SPRINT-002
- **Source:** FIND-SPRINT-002-10 (sprint-code-reviewer); TASK-558-done.md (TASK-558 had to update all four sites in lockstep).
- **Problem:** The Cyboflow commit-message footer string is hardcoded in four places: `main/src/utils/shellEscape.ts:27–30`, `main/src/ipc/file.ts:243–245` and `281–283` (two near-identical retry branches in the same function), and `main/src/services/worktreeManager.ts:625–627`. The same `enableCrystalFooter !== false` ternary is duplicated across all four. Any future change to the footer (URL fix per A2, email change, tagline tweak) requires a coordinated four-site edit and is one missed site away from inconsistency. TASK-558 demonstrated this exact cost when flipping the Crystal→Cyboflow rebrand.
- **Proposed direction:** Add a `buildCommitFooter(enableFooter: boolean): string` function to `main/src/utils/shellEscape.ts` (or extract to a new `main/src/utils/commitFooter.ts`). Replace the four hardcoded blocks with calls. As a bonus, the `file.ts` retry branch at lines 277–285 is a near-verbatim copy of lines 240–249 — extract a `buildCommitMessage(request, config): string` helper to deduplicate both. After this refactor, the next URL/email/tagline change is a single-line edit. Coordinate with B2 (the `enableCrystalFooter` rename) so the helper's parameter name is already `enableCyboflowFooter` when introduced.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified 4 verbatim duplicates of the `💎 Built using [Cyboflow]...Co-Authored-By: Cyboflow` literal at `shellEscape.ts:27-31`, `file.ts:241-245` and `file.ts:279-283`, `worktreeManager.ts:625-629`; TASK-558 already paid the lockstep-edit tax once, and A2's likely URL fix would pay it again — extraction is the smaller fix.
- **Counterfactual:** If B2 (`enableCrystalFooter` rename) absorbs the helper extraction in passing, this becomes a duplicate of B2's work.

### B7. Extract debug-log path helpers in `main/src/index.ts` to eliminate six hardcoded path blocks
- **Summary:** Extract a `getDevDebugLogPath(stream: "frontend" | "backend"): string` helper from `main/src/index.ts` to replace six near-identical 12-line blocks that each hardcode the `cyboflow-*-debug.log` path and format.
- **Source-Sprint:** SPRINT-002
- **Source:** FIND-SPRINT-002-11 (sprint-code-reviewer); TASK-558-done.md (TASK-558 had to change `crystal-*-debug.log` → `cyboflow-*-debug.log` in 8 separate locations).
- **Problem:** `main/src/index.ts:225–490` contains six near-identical 12-line blocks (around lines 225–243, 261–275, 322–337, 378–393, 424–439, 466–480, 640–655) that all format a `[timestamp] [SOURCE LEVEL] message` line and call `fs.appendFileSync` with either `cyboflow-backend-debug.log` or `cyboflow-frontend-debug.log`. TASK-558 had to update 8 separate occurrences to complete the crystal→cyboflow filename rename. The next rebrand pass, log-format change, or attempt to add log rotation will walk all 8 sites again.
- **Proposed direction:** Extract two helpers: `getDevDebugLogPath(stream: "frontend" | "backend"): string` (returns the absolute log file path) and `appendDevDebugLog(stream: "frontend" | "backend", level: string, source: string, message: string): void` (formats the timestamp line and calls `appendFileSync`). The six console-hook blocks in `index.ts` each call `appendDevDebugLog`. Optional improvement: replace `appendFileSync` with a tiny ring buffer or use `main/src/utils/logger.ts` (already wraps `winston` with rolling file support) to avoid synchronous I/O on every console log line in dev.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed 9 occurrences of `cyboflow-{frontend,backend}-debug.log` in `main/src/index.ts` (verified `grep -c`), and `index.ts:225-275` shows the same 12-line timestamp+appendFileSync pattern repeated for each console hook; the next log-format or rotation change walks all sites again.
- **Counterfactual:** If `main/src/utils/logger.ts` is already structured to absorb the dev-mode debug log writes, the simpler change is to route the six hooks through it directly rather than introducing two new helpers.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add `docs/signing/APPLE_DEVELOPER_SETUP.md` to CLAUDE.md's Reference Docs list
- **Summary:** Add the Apple signing setup guide to CLAUDE.md's Reference Docs section so agents doing any build-related task automatically load the env-var contract and provisioning steps.
- **Source-Sprint:** SPRINT-002
- **Target file:** `CLAUDE.md`
- **Action:** insert-after "`docs/crystal-legacy/` — historical Crystal docs preserved for reference (CLI tool integration guides, troubleshooting)."
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
   - `docs/crystal-legacy/` — historical Crystal docs preserved for reference (CLI tool integration guides, troubleshooting).
  +- `docs/signing/APPLE_DEVELOPER_SETUP.md` — Apple signing env-var contract and provisioning steps. Load before any build, packaging, or release task.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `docs/signing/APPLE_DEVELOPER_SETUP.md` exists (verified `ls`), is referenced from `scripts/configure-build.js`'s env-var contract, but is absent from CLAUDE.md's Reference Docs list — a one-line addition that future build/packaging tasks will need.

### C2. Add a localStorage Migration pointer to CLAUDE.md
- **Summary:** Add a two-line CLAUDE.md pointer that names `migrateLocalStorageKey` as the canonical helper for any localStorage key rename and forwards to CODE-PATTERNS.md for the call contract.
- **Source-Sprint:** SPRINT-002
- **Target file:** `CLAUDE.md`
- **Action:** append (new section after `## TypeScript Rules`)
- **Status:** ready
- **source_item:** C2
- **Diff:**
  ```diff
  +
  +## localStorage Key Migrations
  +
  +Use `frontend/src/utils/migrateLocalStorageKey.ts` for any localStorage key rename — never write ad-hoc `getItem`/`setItem` rename logic. See `docs/CODE-PATTERNS.md` for the mount-only call contract and the `console.ts` anti-pattern.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The helper has 4 active call sites (verified in App.tsx, FileEditor.tsx, RichOutputWithSidebar.tsx, console.ts) and one already misuses it per-call (FIND-SPRINT-002-8) — a short pointer in CLAUDE.md plus the CODE-PATTERNS.md entry (C3) is the smallest fix that prevents the next rename from rediscovering the helper.
- **Counterfactual:** If a tighter "no new top-level CLAUDE.md sections" rule is in force, C3 alone (CODE-PATTERNS entry) is sufficient and C2's pointer is skippable.

### C3. Document `migrateLocalStorageKey` call contract in CODE-PATTERNS.md
- **Summary:** Add a Shared Utilities entry for `migrateLocalStorageKey` documenting its mount-only call contract and flagging the `console.ts` per-render anti-pattern.
- **Source-Sprint:** SPRINT-002
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** insert-after "### `frontend/src/utils/api`" block (under `## Shared Utilities`)
- **Status:** ready
- **source_item:** C2
- **Diff:**
  ```diff
   ### `frontend/src/utils/api`
   
   - **Path:** `frontend/src/utils/api.ts`
   - **Use it for:** All IPC calls from renderer to main. Do not call `window.electron` directly
     from components — go through this module.
   - **Canonical example:** Any store in `frontend/src/stores/`
  +
  +### `frontend/src/utils/migrateLocalStorageKey`
  +
  +- **Path:** `frontend/src/utils/migrateLocalStorageKey.ts`
  +- **Use it for:** One-shot localStorage key rename (e.g. crystal-→cyboflow-). Reads legacy key,
  +  copies value to new key, deletes legacy key, returns value. Idempotent.
  +- **Call contract:** Invoke inside `useEffect(..., [])` or a `useState(() => ...)` initializer —
  +  never inside a closure that runs on every render or log call.
  +- **Canonical example:** `frontend/src/App.tsx:60` (mount-time call).
  +- **Anti-pattern:** `frontend/src/utils/console.ts:9–12` calls it inside `isVerboseEnabled()`,
  +  which fires on every `devLog.*` invocation — redundant localStorage reads per log line.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified 4 call sites of `migrateLocalStorageKey` plus the documented anti-pattern at `frontend/src/utils/console.ts:10` (called from `isVerboseEnabled`) — the entry slots naturally into `docs/CODE-PATTERNS.md`'s existing Shared Utilities section and names a concrete trap that future agents will otherwise rediscover.

### C4. Document the `configure-build.js` signing posture contract in CODE-PATTERNS.md
- **Summary:** Add a Build & Packaging entry to CODE-PATTERNS.md stating that `configure-build.js` is the single canonical writer of `build.mac.notarize`, `hardenedRuntime`, and `gatekeeperAssess` — direct `package.json` edits of those keys are overwritten at build time.
- **Source-Sprint:** SPRINT-002
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** create-section "## Build & Packaging" (insert before the closing `/soloflow:compound` line)
- **Status:** ready
- **source_item:** C3
- **Diff:**
  ```diff
  +## Build & Packaging
  +
  +### macOS signing posture (`scripts/configure-build.js`)
  +
  +`scripts/configure-build.js` runs as a `prebuild:mac*` / `prerelease:mac` step and is the
  +**single canonical writer** of `build.mac.notarize`, `hardenedRuntime`, and `gatekeeperAssess`.
  +Do not edit these keys directly in `package.json` — `configure-build.js` overwrites them on
  +every build. Decision is driven by env vars (`CSC_LINK`, `APPLE_ID`, `APPLE_TEAM_ID`,
  +`APPLE_APP_SPECIFIC_PASSWORD`, `CSC_KEY_PASSWORD`, `CSC_DISABLE`).
  +
  +- **Canonical example:** `scripts/configure-build.js`, `scripts/configure-build.test.js`
  +- **Env-var contract:** see `docs/signing/APPLE_DEVELOPER_SETUP.md`.
  +
   `/soloflow:compound` will append patterns extracted from completed sprints to this file over time.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `package.json:114` literally has `"notarize": { "teamId": "${APPLE_TEAM_ID}" }` which `scripts/configure-build.js` overwrites unconditionally (FIND-SPRINT-002-7 confirms the dead config); documenting `configure-build.js` as single writer prevents the next agent from "fixing" the package.json value and silently breaking the signing toggle.
- **Counterfactual:** If FIND-SPRINT-002-7's suggested cleanup (drop the dead notarize block from package.json) lands first, this rule is documenting a non-trap and could be dropped.

### C5. Document the commit-footer literal and its four call sites in CODE-PATTERNS.md
- **Summary:** Add a Shared Utilities entry naming `buildGitCommitCommand` in `shellEscape.ts` as the canonical footer producer and warning that the literal is duplicated across four sites until B6 deduplicates them.
- **Source-Sprint:** SPRINT-002
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** insert-after "### `main/src/utils/logger`" block (under `## Shared Utilities`)
- **Status:** ready
- **source_item:** C4
- **Diff:**
  ```diff
   ### `main/src/utils/logger`
   
   - **Path:** `main/src/utils/logger.ts`
   - **Use it for:** Structured file logging in the main process. Rolling 10 MB logs, max 5 files.
     Captures original `console.*` methods before any override to avoid recursion.
   - **Canonical example:** `main/src/services/sessionManager.ts`
  +
  +### Cyboflow commit-message footer
  +
  +- **Canonical producer:** `buildGitCommitCommand` in `main/src/utils/shellEscape.ts`.
  +- **Do not** hardcode the `💎 Built using [Cyboflow]...` + `Co-Authored-By` literal at new call
  +  sites — route the commit through `buildGitCommitCommand` so URL/email/tagline edits are one-line.
  +- **Active literal duplicates (pending B6 dedup):** `main/src/ipc/file.ts` (two branches),
  +  `main/src/services/worktreeManager.ts`. Any footer change must update all four sites in lockstep.
  ```

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Calling `buildGitCommitCommand` in `main/src/utils/shellEscape.ts:25` the "canonical producer" is misleading — `commitManager.ts` routes through it but `file.ts` and `worktreeManager.ts` hardcode the literal directly without calling it (verified by grep: only `commitManager.ts` imports `buildGitCommitCommand`), so a rule that says "route through buildGitCommitCommand" doesn't match current code; if B6 lands, the new helper supersedes this rule anyway.
- **Counterfactual:** If B6 is deferred and someone first refactors `file.ts` / `worktreeManager.ts` to route through `buildGitCommitCommand`, the canonical-producer claim becomes truthful and this entry would be worth adding.

---

## Reconciled Findings (informational)

FIND-SPRINT-002-4 has `resolved_by: *` in the findings file, which is not a standard `resolved_by: TASK-NNN` claim. No done report contains a `**Findings resolved:**` line referencing FIND-SPRINT-002-4. Treated as open and triaged as B1. The asterisk appears to be an editorial note from the sprint-closer rather than a resolution claim.

No other findings have non-empty `resolved_by` fields. No done reports contain `**Findings resolved:**` lines. No reconciliation drift detected.

---

## Suppressed — SoloFlow Defects

- **Executor sprint-id resolution (FIND-SPRINT-002-2)** — TASK-557's executor logged a finding into `SPRINT-001-findings.md` while the active sprint was SPRINT-002, because the executor agent prompt resolved the findings file path from a stale or incorrect source rather than from the live active-sprint manifest. This describes SoloFlow executor agent behavior, not a cyboflow project convention. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.
