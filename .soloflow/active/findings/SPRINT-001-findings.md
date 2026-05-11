---
sprint: SPRINT-001
pending_count: 9
last_updated: "2026-05-11T23:00:00.000Z"
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
- **resolved_by:***
