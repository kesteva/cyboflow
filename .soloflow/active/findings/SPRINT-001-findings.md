---
sprint: SPRINT-001
pending_count: 16
last_updated: "2026-05-11T23:06:34.648Z"
---
# Findings Queue

## FIND-SPRINT-001-1
- **source:** TASK-001 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/services/panels/ai/AbstractAIPanelManager.ts, main/src/ipc/baseAIPanelHandler.ts
- **description:** After Codex deletion, `AbstractAIPanelManager` has exactly one concrete subclass (`ClaudePanelManager`) and `BaseAIPanelHandler` has exactly one concrete subclass (`ClaudePanelHandler`). Unlike `AbstractCliManager` (which is explicitly preserved as planned extension infrastructure per `docs/cyboflow_system_design.md` line 64), these AI-panel abstractions were Crystal-era scaffolding for the Claude+Codex split and are not called out in the cyboflow architecture as future-extension points. They now constitute one-subclass abstractions — pure indirection.
- **suggested_action:** Once TASK-005 lands and the multi-panel UI is gone, evaluate collapsing `AbstractAIPanelManager` into `ClaudePanelManager` and `BaseAIPanelHandler` into `ClaudePanelHandler`. Keep `AbstractCliManager` (planned extension surface).
- **resolved_by:** 

## FIND-SPRINT-001-2
- **source:** TASK-001 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/components/panels/ai/transformers/MessageTransformer.ts:1-16
- **description:** `SessionInfoData` interface retains Codex-only fields (`modelProvider`, `approvalPolicy`, `sandboxMode`, `resumeSessionId`, `isResume`) that the Claude transformer (`ClaudeMessageTransformer.ts`) never populates. The permissive index signature `[key: string]: unknown` masks the unused fields from type errors. Mostly cosmetic, but the interface now misrepresents what the codebase actually emits.
- **suggested_action:** Trim to Claude-actual fields: `initialPrompt`, `claudeCommand`, `worktreePath`, `model`, `permissionMode`, `timestamp`.
- **resolved_by:** 

## FIND-SPRINT-001-3
- **source:** TASK-004 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/session/CommitMessageDialog.tsx:1
- **description:** TASK-004 removed the `<CommitMessageDialog />` JSX usage from `SessionView.tsx` and added `@cyboflow-hidden` markers at the import line and at the former render site. The component file itself, however, has no `@cyboflow-hidden` header. A future agent grep-ing for active components will hit this file and may not realize it is unreachable in v1. Consistency-wise, `worktreeManager.ts` got the annotation at the method group; this file is the analogous frontend artifact and should match the pattern.
- **suggested_action:** Add a top-of-file comment block to `CommitMessageDialog.tsx`: `// @cyboflow-hidden: This dialog is unreachable in cyboflow v1. The rebase/squash UI entry points that triggered it were removed in TASK-004. Re-enable by re-adding the `<CommitMessageDialog />` JSX in SessionView.tsx.`
- **resolved_by:** 

## FIND-SPRINT-001-4
- **source:** TASK-004 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useSessionView.ts:1329,1405,1434,1475
- **description:** Four handlers (`handleRebaseMainIntoWorktree`, `handleSquashAndRebaseToMain`, `performSquashWithCommitMessage`, `performSquashWithCommitMessageAndArchive`) and their related state (`showCommitMessageDialog`, `hasChangesToRebase`, `isMergingAndArchiving`, `commitMessage`, `dialogType`, `shouldSquash`) are still exported from `useSessionView` but no consumer in the frontend tree reads them after TASK-004. Plan acceptance criterion 4 explicitly required keeping these exports, so this is preserved dead surface per design — but the hook lacks the `@cyboflow-hidden` annotation that `worktreeManager.ts:472` got. For parity, the handler group should be annotated so future readers know the exports are intentionally inactive.
- **suggested_action:** Add a `// @cyboflow-hidden` comment block above the `handleRebaseMainIntoWorktree` declaration (around line 1329) covering the four handlers, with the same "re-enable by adding branch action entries back in SessionView.tsx" guidance used in `worktreeManager.ts`.
- **resolved_by:** 

## FIND-SPRINT-001-5
- **source:** TASK-002 (code-reviewer)
- **type:** cleanup
- **severity:** medium
- **location:** main/package.json:24, main/package.json:35, main/package.json:20
- **status:** open
- **description:** TASK-002 removed `bull`, `@types/bull`, and `@anthropic-ai/sdk` from the root `package.json`, but the `main` workspace sub-package (`main/package.json`) still declares all three: `bull@^4.16.3` (line 24), `@types/bull@^4.10.0` (line 35), and `@anthropic-ai/sdk@^0.60.0` (line 20). In this pnpm workspace, sub-package dependencies drive what actually gets installed under `node_modules` for the main process — root-only removal does not unblock the install graph or shrink the runtime bundle. Code references to Bull and the Anthropic SDK are fully gone (grep is clean), so these are pure phantom deps, but they keep `ioredis` and the entire Anthropic SDK transitive tree on disk and in `pnpm-lock.yaml`. The TASK-002 plan's `files_owned` listed only the root `package.json`, so the executor was technically in scope, but the plan under-specified the workspace structure.
- **suggested_action:** Delete `bull`, `@types/bull`, and `@anthropic-ai/sdk` entries from `main/package.json` (lines 20, 24, 35), then `pnpm install` to regenerate the lockfile. Verify `pnpm run build:main && pnpm typecheck` still pass. This finalizes the deletion that TASK-002 started.
- **resolved_by:** 

## FIND-SPRINT-001-6
- **type:** scope_deviation
- **source:** TASK-005 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/types/panelComponents.ts
- **description:** Executor modified a file listed in `files_readonly`. Reviewed by code-reviewer (TASK-005): the modification was minimal and structurally required — removing `onPanelCreate` from `PanelTabBarProps` was the only way to satisfy AC#2 ("`<PanelTabBar>` component no longer accepts an `onPanelCreate` prop"). The plan's acceptance-criteria text in fact instructs the field be removed from this interface, contradicting the `files_readonly` listing. The diff was confined to (a) dropping `ToolPanelType` from the import and (b) deleting the `onPanelCreate` field — no other liberties taken. This was a plan inconsistency, not executor misbehavior.
- **suggested_action:** Future plans should not list a file as read-only when an acceptance criterion requires editing it. Plan template should validate `files_owned` covers every file whose change is named in acceptance criteria.
- **resolved_by:** TASK-005 (code-reviewer)

## FIND-SPRINT-001-7
- **type:** improvement
- **source:** TASK-005 (code-reviewer)
- **severity:** low
- **status:** open
- **location:** frontend/src/components/ProjectView.tsx:158, frontend/src/components/SessionView.tsx (handlePanelCreated handlers)
- **description:** `handlePanelCreate` (creator) and `handlePanelCreated` (event listener) coexist in `ProjectView.tsx`, differing by one trailing `d`. After TASK-005, `handlePanelCreate` is only called internally by `handleGitPull`/`handleGitPush` as a fallback when no Claude panel exists, and `handlePanelCreated` is the `panel:created` IPC subscriber. The near-identical names are a readability hazard — a future maintainer skim-reading the file may confuse the imperative creator with the past-tense event handler. In SessionView, after this task removed `handlePanelCreate` entirely, only `handlePanelCreated` remains, so the collision is localized to ProjectView.
- **suggested_action:** Rename `handlePanelCreate` in `ProjectView.tsx` to something action-specific like `ensureClaudePanel` or `createClaudePanelFallback` (since post-TASK-005 it only ever creates a `'claude'` panel). Leaves `handlePanelCreated` as the only "panel created" identifier in the file.
- **resolved_by:** 

## FIND-SPRINT-001-8
- **source:** TASK-003 (code-reviewer)
- **type:** cleanup
- **severity:** medium
- **status:** open
- **location:** main/src/services/taskQueue.ts:94-97,134-135; main/src/services/analyticsManager.ts:105,143,178; main/src/services/panels/claude/claudeCodeManager.ts:385
- **description:** TASK-003 deleted Linux/Windows platform branches from `files_owned`, but identical `isLinux`/`os.platform() === 'linux'` patterns survive in three out-of-scope files. `taskQueue.ts` halves the session concurrency cap on Linux (1 vs 5) — dead branch on a macOS-only build. `claudeCodeManager.ts:385` (`skipDirTest = os.platform() === 'linux'`) is dead by definition. `analyticsManager.ts` legitimately needs `os.platform()` for telemetry payloads (line 105, 143, 178), so those three call sites should stay; only the branch-on-linux pattern should be removed. The executor correctly skipped these per `files_owned`; flagging for a follow-up task to finish the deletion sweep.
- **suggested_action:** Open a follow-up cleanup task that owns `taskQueue.ts`, `claudeCodeManager.ts`, and revisits `analyticsManager.ts` (only to confirm `os.platform()` is used purely as a telemetry value, not as a branch predicate). Collapse `taskQueue.ts:94-97` to `const sessionConcurrency = 5;` and remove the duplicate at 134-135. Replace `claudeCodeManager.ts:385` `skipDirTest = os.platform() === 'linux'` with `skipDirTest = false` (or drop the guard entirely if the directory test always runs on macOS).
- **resolved_by:** 

## FIND-SPRINT-001-9
- **source:** TASK-003 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/utils/shellPath.ts:73-172; main/src/services/runCommandManager.ts:297-350; main/src/services/panels/cli/AbstractCliManager.ts:855-902; main/src/services/panels/cli/AbstractCliManager.ts:531; main/src/services/panels/logPanel/logsManager.ts:227-230; main/src/services/sessionManager.ts:1370-1371; main/src/ipc/app.ts:12-14 + main/src/preload.ts:181 + frontend/src/types/electron.d.ts:37
- **description:** Cosmetic residue from TASK-003's platform-branch deletion: (a) three bare `{ ... }` block-scopes remain where the macOS arm of an `if/else if/else` once lived — they compile and behave correctly but signal "leftover collapsed branch" to readers (`shellPath.ts:73-172`, `runCommandManager.ts:297-350`, `AbstractCliManager.ts:855-902`); (b) stale comments still reference Linux/Windows: `AbstractCliManager.ts:531` says "(includes Linux-specific paths)", `logsManager.ts:227-230` and `sessionManager.ts:1370-1371` still describe "taskkill on Windows" and "process tree (Windows)" in JSDoc; (c) the `get-platform` IPC handler, its preload binding (`getPlatform`), and its frontend type declaration are now unreferenced — `grep` for `electronAPI.getPlatform` returns zero hits in `frontend/src` after this task removed the last consumer in `Settings.tsx`.
- **suggested_action:** Flatten the three bare blocks (delete the wrapping braces, dedent the body) so the macOS code reads as the sole path. Rewrite the three stale comments to drop Linux/Windows mentions. Either remove the `get-platform` IPC handler + preload + type declaration (now dead), or keep it as documented telemetry surface — decide as part of the same cleanup.
- **resolved_by:** *

## FIND-SPRINT-001-10
- **type:** bug
- **source:** TASK-006 (executor)
- **severity:** medium
- **status:** open
- **location:** main/src/services/__tests__/gitStatusManager.test.ts
- **description:** 19 of 23 tests in gitStatusManager.test.ts fail with TypeErrors (e.g., executeGitCommand is not a function, pollAllSessions does not exist) and assertion errors (state always returns conflict instead of clean/modified/etc). These failures existed in the Crystal baseline fork at 7a5ee42 and are unrelated to TASK-006 changes. The test file references private methods and internal state that no longer match the current gitStatusManager implementation.
- **suggested_action:** Rewrite gitStatusManager.test.ts to match the current public API, or delete it if the service is sufficiently covered by E2E tests.
- **resolved_by:** 

## FIND-SPRINT-001-11
- **source:** TASK-006 (code-reviewer)
- **type:** cleanup
- **severity:** medium
- **status:** open
- **location:** frontend/src/assets/crystal-logo.svg (imported by Sidebar.tsx:6, Welcome.tsx:3, AnalyticsConsentDialog.tsx:3); main/src/utils/logger.ts:73,86,106; main/src/ipc/file.ts:245,248,283,286; main/src/services/worktreeManager.ts:629; main/src/utils/shellEscape.ts:31; main/src/services/panels/claude/claudeCodeManager.ts:340 ("Crystal Settings"); frontend/src/components/panels/SetupTasksPanel.tsx:81,90,459; frontend/src/App.tsx:61 ("crystal-sidebar-width" localStorage key); frontend/src/components/panels/editor/FileEditor.tsx:608; frontend/src/utils/console.ts:10; frontend/src/components/panels/claude/RichOutputWithSidebar.tsx:38; main/src/services/analyticsManager.ts:39 ("crystal_" distinctId prefix); main/src/index.ts:93-94,227,261,323,379,427,467 (debug log filenames); main/src/index.ts:114-122 (--crystal-dir CLI flag); main/src/services/panels/claude/claudeCodeManager.ts:889 (crystal-base-mcp-{id}.json filename).
- **description:** TASK-006 completed the in-scope rebrand (appId, productName, data dir, env var, README, AboutDialog). However, with the rebrand now public, several user-visible and analytics-visible "Crystal" strings remain across the codebase outside the task's `files_owned`: (1) `frontend/src/assets/crystal-logo.svg` is still shipped and rendered by Sidebar/Welcome/AnalyticsConsentDialog with `alt="Crystal"`, contradicting the new Cyboflow logo placeholder in AboutDialog; (2) log file names (`crystal-{date}.log`, `crystal-frontend-debug.log`, `crystal-backend-debug.log`) are now Cyboflow log files with Crystal prefixes; (3) git commit co-author trailer is still `Co-Authored-By: Crystal <crystal@stravu.com>`, which will be visible on every commit Cyboflow makes; (4) localStorage keys (`crystal-sidebar-width`, `crystal.verboseLogging`, `crystal-file-tree-width`, `crystal-sidebar-collapsed-{id}`) — non-cosmetic since they persist; (5) PostHog distinctId prefix `crystal_{uuid}` will bleed Crystal-era IDs into Cyboflow analytics; (6) error message at claudeCodeManager.ts:340 reads "Or set a custom Claude executable path in Crystal Settings" — user-facing and now wrong; (7) the `--crystal-dir` CLI flag was kept as backward-compat but `CRYSTAL_DIR` env var was renamed without backward-compat, an inconsistent migration story; (8) SetupTasksPanel hard-codes `./crystal-run.sh` as the run-script filename it tells Claude to create. The plan explicitly scoped `getCrystalDirectory()`, `crystal-permissions`, and `crystal-mcp-<sessionId>.json` as deferred, but did not call out these other surfaces.
- **suggested_action:** Open a follow-up task "Finish Crystal-string sweep" with `files_owned` covering: the three components that import `crystal-logo.svg` (swap to a Cyboflow asset or remove); `logger.ts` log filename pattern (`cyboflow-{date}.log`); `index.ts` debug log filenames (`cyboflow-frontend-debug.log`, `cyboflow-backend-debug.log`); `shellEscape.ts` + `file.ts` + `worktreeManager.ts` commit trailer (`Co-Authored-By: Cyboflow <hello@cyboflow.com>`); the four localStorage keys (with migration to read old keys on first load if state preservation matters); `analyticsManager.ts` distinctId prefix (`cyboflow_{uuid}` — keep mapping table if telemetry continuity matters); the user-visible error string at `claudeCodeManager.ts:340`; `SetupTasksPanel` run-script default. Decide whether `--crystal-dir` CLI flag should keep its backward-compat alias or also rename to `--cyboflow-dir` (consistency with the env-var migration). Update `CLAUDE.md`'s debug-log filename guidance to match.
- **resolved_by:** 

## FIND-SPRINT-001-12
- **source:** SPRINT-001 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** shared/types/aiPanelConfig.ts:47-57
- **description:** `AIPanelConfigFactory` class with static `createClaudeConfig()` is exported but has zero consumers across the entire repo (grep `AIPanelConfigFactory|createClaudeConfig` returns only the declaration itself). After TASK-001 removed the Codex panel and its config factory siblings, this Crystal-era factory is pure dead code. The interfaces `AIPanelConfig`, `StartPanelConfig`, `ContinuePanelConfig`, `AIPanelState` in the same file ARE still used (claudePanelManager.ts, AbstractAIPanelManager.ts) — only the factory class is orphaned.
- **suggested_action:** Delete the `AIPanelConfigFactory` class (lines 47-57 of `shared/types/aiPanelConfig.ts`). Keep the four interfaces above it (still in active use). This is a self-contained 11-line removal with no consumer breakage risk.
- **resolved_by:** 






Suspected tasks: TASK-001

## FIND-SPRINT-001-13
- **source:** SPRINT-001 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/Sidebar.tsx:109-110, frontend/src/components/Welcome.tsx:50-52, frontend/src/components/AnalyticsConsentDialog.tsx:80-81
- **description:** TASK-006 rebranded the app to Cyboflow (package name, productName, appId, AboutDialog header), but three highly visible top-level UI strings still display the literal text **"Crystal"** in `<h1>` headings and `alt="Crystal"` image attributes:
- **suggested_action:** Edit the three components: replace `<h1>Crystal</h1>` → `<h1>Cyboflow</h1>` in Sidebar.tsx:110; replace `<h1>Welcome to Crystal</h1>` → `<h1>Welcome to Cyboflow</h1>` in Welcome.tsx:52; replace `<h1>Help Improve Crystal</h1>` → `<h1>Help Improve Cyboflow</h1>` in AnalyticsConsentDialog.tsx:81. Update the three `alt="Crystal"` attributes to `alt="Cyboflow"`. Bundle with the logo-asset swap from FIND-SPRINT-001-11.
- **resolved_by:** 





- `Sidebar.tsx:109-110` → `<img src={crystalLogo} alt="Crystal" .../> <h1 ...>Crystal</h1>` (left sidebar, always visible)
- `Welcome.tsx:50-52` → `<img ... alt="Crystal" /> <h1>Welcome to Crystal</h1>` (first-run welcome screen)
- `AnalyticsConsentDialog.tsx:80-81` → `<img ... alt="Crystal" /> <h1>Help Improve Crystal</h1>` (consent gate shown on first launch)

These are not the same as the deferred `crystal-logo.svg` asset call-out in FIND-SPRINT-001-11 — that finding mentions the import path, but the actual user-visible `<h1>` *text content* ("Crystal", "Welcome to Crystal", "Help Improve Crystal") is what users see on every launch. The rebrand is half-done from a user perspective until these are swapped to "Cyboflow".

Suspected tasks: TASK-006

## FIND-SPRINT-001-14
- **source:** SPRINT-001 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/types/config.ts:4, main/src/types/config.ts:67
- **description:** `AppConfig.openaiApiKey?: string` (line 4) and `UpdateConfigRequest.openaiApiKey?: string` (line 67) are declared but have **zero consumers** anywhere in the repo. TASK-001 deleted the entire Codex/OpenAI integration (codexManager.ts, codexPanelManager.ts, frontend Codex components) but missed the two stray field declarations in the main process config types. Because `configManager.ts` simply spreads the JSON config blob and never references `openaiApiKey`, the value is invisibly persisted in users\` `~/.cyboflow/config.json` if it was set during Crystal era — harmless, but the type surface lies about what the app actually does with the field.
- **suggested_action:** Delete `openaiApiKey?: string;` from `main/src/types/config.ts:4` and `:67`. Verify `pnpm typecheck` still passes (no consumers reference it). Optional: add a one-time migration in `configManager.ts` that strips `openaiApiKey` from the persisted JSON on next save — but lazy-discard on save is fine since the field is harmless if left in `config.json`.
- **resolved_by:** 




This is a pure cross-task artifact: TASK-001 owned config schema cleanup for codex but the executor scope-limited to runtime code paths.

Suspected tasks: TASK-001

## FIND-SPRINT-001-15
- **source:** SPRINT-001 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/ProjectView.tsx:9, frontend/src/components/ProjectView.tsx:158-173
- **description:** Cross-task narrowing inconsistency. TASK-001 narrowed `ToolPanelType` to remove `codex`; TASK-005 removed the multi-panel "Add Tool" UI and dropped `onPanelCreate` from `PanelTabBarProps`. After both changes, `ProjectView.handlePanelCreate` is the **only surviving `handlePanelCreate`** in the frontend tree, and the only call sites are at lines 182 and 193 where it is invoked exclusively as `handlePanelCreate(\`claude\`)` (Pull/Push fallback when no Claude panel exists).
- **suggested_action:** Tighten the signature to match actual usage. Either: (a) inline both call sites — replace `handlePanelCreate(\`claude\`)` with a direct `panelApi.createPanel({ sessionId: mainRepoSessionId, type: \`claude\` })` block; or (b) rename + narrow: `const ensureClaudePanel = useCallback(async () => { ... })` taking no arguments (combine with the rename proposed in FIND-SPRINT-001-7). Either path lets you drop the `ToolPanelType` import from line 9.
- **resolved_by:** 



The callback signature however is `async (type: ToolPanelType)` (line 159), and `ToolPanelType` is imported solely for this signature. The type promises capability the function no longer has — a future reader will assume the helper can create dashboard/logs/editor panels and try to call it as such. Couples with FIND-SPRINT-001-7 (the `handlePanelCreate`/`handlePanelCreated` naming collision in the same file).

Suspected tasks: TASK-001, TASK-005

## FIND-SPRINT-001-16
- **source:** SPRINT-001 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts.backup, frontend/src/components/panels/claude/ClaudePanel.tsx.backup
- **description:** Two `.backup` files are git-tracked in the source tree: `main/src/services/panels/claude/claudeCodeManager.ts.backup` (60 KB) and `frontend/src/components/panels/claude/ClaudePanel.tsx.backup`. They predate SPRINT-001 (introduced in the fork baseline commit `7a5ee42 chore: fork stravu/crystal at HEAD as cyboflow baseline`), so this sprint did not create them — but the sprint touched the live `.ts`/`.tsx` siblings extensively (TASK-006 modified `claudeCodeManager.ts`) without addressing the stale backups. They are excluded from build outputs and never imported, but they (a) inflate `git ls-files` results and grep noise, (b) confuse future readers who may interpret them as fallback implementations, and (c) keep deprecated Crystal-era code committed.
- **suggested_action:** Delete both files with `git rm`. Verify nothing imports them: `grep -r "ClaudePanel.tsx.backup\\|claudeCodeManager.ts.backup" .` should return zero hits. Add `*.backup` to `.gitignore` to prevent recurrence. This is a 60KB+ deletion with zero behavior change.
- **resolved_by:** 


Out-of-scope for this sprint per `files_owned`, but called out here as a cross-task observation: the sprint cleaned ~9700 lines of dead code and these two large `.backup` files are conspicuous holdouts.

Suspected tasks: pre-sprint baseline (not introduced by sprint)

## FIND-SPRINT-001-17
- **source:** SPRINT-001 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** pnpm-lock.yaml:14-46 (root importer block)
- **description:** `pnpm-lock.yaml` is stale relative to the new root `package.json`. The root importer block (`importers: .:`) still declares these as direct dependencies:

- `@anthropic-ai/sdk: specifier ^0.60.0, version 0.60.0` (lockfile lines ~13)
- `bull: specifier ^4.16.3, version 4.16.5` (lockfile lines ~24)
- `openai: specifier ^5.1.1, version 5.10.1` (lockfile lines ~38)

These three packages were removed from root `package.json` by TASK-001 (`openai`) and TASK-002 (`bull`, `@anthropic-ai/sdk`) but the lockfile was not regenerated. Cross-task interaction: both tasks edited root `package.json`, TASK-006 also touched root `package.json` (rebrand), and the lockfile silently drifted from all three.

Impact: (a) `pnpm install` will warn or auto-resolve and the lockfile churn will appear in a future unrelated PR; (b) `pnpm install --frozen-lockfile` (typically used in CI) will currently still install bull/openai/sdk and their transitive trees (~50+ MB) into `node_modules` even though no code imports them; (c) supply-chain surface: every transitive dep of bull/openai/sdk is still on disk and exposed to npm audit.

This is a separate concern from FIND-SPRINT-001-5 (which is about `main/package.json` still declaring bull/sdk in the **workspace sub-package**). Fixing main/package.json without also regenerating the lockfile leaves the root drift.

Suspected tasks: TASK-001, TASK-002, TASK-006
- **suggested_action:** After fixing FIND-SPRINT-001-5 (delete bull/`@types/bull`/`@anthropic-ai/sdk` from main/package.json), run `pnpm install` from the repo root to regenerate the lockfile. Verify: `grep -E "^  (bull|openai|@anthropic-ai/sdk):" pnpm-lock.yaml` returns zero hits after regen. Verify `pnpm run build:main && pnpm typecheck && pnpm lint` all pass. Commit the regenerated lockfile.
- **resolved_by:** 
