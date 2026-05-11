---
sprint: SPRINT-001
pending_count: 5
last_updated: "2026-05-11T23:30:00Z"
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
