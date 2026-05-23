---
id: TASK-691
idea: IDEA-017
status: in-flight
created: "2026-05-20T00:00:00Z"
files_owned:
  - frontend/src/components/SessionView.tsx
  - frontend/src/components/StravuFileSearch.tsx
  - frontend/src/components/session/SessionHeader.tsx
  - frontend/src/components/session/SessionInput.tsx
  - frontend/src/components/session/RichOutputSettingsPanel.tsx
  - frontend/src/components/session/GitErrorDialog.tsx
  - frontend/src/components/session/FolderArchiveDialog.tsx
  - frontend/src/components/session/CommitMessageDialog.tsx
  - frontend/src/hooks/useSessionView.ts
  - frontend/src/stores/sessionHistoryStore.ts
  - docs/CODE-PATTERNS.md
  - main/src/services/worktreeManager.ts
files_readonly:
  - frontend/src/App.tsx
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/components/ProjectView.tsx
  - frontend/src/components/SessionListItem.tsx
  - frontend/src/components/DraggableProjectTreeView.tsx
  - frontend/src/components/panels/PanelContainer.tsx
  - frontend/src/components/panels/cli/CliPanelFactory.tsx
  - frontend/src/components/panels/claude/ClaudePanel.tsx
  - frontend/src/components/session/ThinkingPlaceholder.tsx
  - frontend/src/stores/sessionStore.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/utils/api.ts
  - frontend/src/contexts/SessionContext.tsx
  - frontend/src/hooks/useClaudePanel.ts
  - frontend/src/hooks/useAddTerminalShortcut.ts
acceptance_criteria:
  - criterion: SessionView.tsx and sole-importer descendants are deleted from the working tree.
    verification: "test ! -e frontend/src/components/SessionView.tsx && test ! -e frontend/src/hooks/useSessionView.ts && test ! -e frontend/src/stores/sessionHistoryStore.ts && test ! -e frontend/src/components/session/SessionHeader.tsx && test ! -e frontend/src/components/session/SessionInput.tsx && test ! -e frontend/src/components/session/RichOutputSettingsPanel.tsx && test ! -e frontend/src/components/session/GitErrorDialog.tsx && test ! -e frontend/src/components/session/FolderArchiveDialog.tsx && test ! -e frontend/src/components/session/CommitMessageDialog.tsx && test ! -e frontend/src/components/StravuFileSearch.tsx — all exit 0"
  - criterion: No SessionView references remain in frontend/src/.
    verification: "grep -rn 'SessionView' frontend/src/ returns 0 matches"
  - criterion: No useSessionView references remain in frontend/src/.
    verification: "grep -rn 'useSessionView' frontend/src/ returns 0 matches"
  - criterion: No imports of deleted session-only descendants remain.
    verification: "grep -rnE \"from\\s+['\\\"][^'\\\"]*(session/SessionHeader|session/SessionInput|session/RichOutputSettingsPanel|session/GitErrorDialog|session/FolderArchiveDialog|session/CommitMessageDialog|StravuFileSearch|sessionHistoryStore)\" frontend/src/ returns 0 matches"
  - criterion: Preservation set still resolves importers.
    verification: "grep -rnE \"from\\s+['\\\"][^'\\\"]*(session/ThinkingPlaceholder|SessionListItem|stores/sessionStore|panels/ai/RichOutputView|panels/ai/MessagesView|panels/claude/ClaudePanel|panels/claude/SessionStats|panels/claude/PromptNavigation|panels/diff/CombinedDiffView)\" frontend/src/ returns ≥1 match per pattern"
  - criterion: TypeScript compiles with zero errors.
    verification: pnpm typecheck exits 0
  - criterion: ESLint passes.
    verification: pnpm lint exits 0
  - criterion: Unit/component test suites pass.
    verification: "pnpm test:unit exits 0"
  - criterion: docs/CODE-PATTERNS.md no longer points at deleted SessionView.tsx as canonical @cyboflow-hidden example.
    verification: "grep -n 'SessionView' docs/CODE-PATTERNS.md returns 0 matches"
  - criterion: worktreeManager.ts @cyboflow-hidden re-enable hint does not reference deleted SessionView.tsx.
    verification: "grep -n 'SessionView' main/src/services/worktreeManager.ts returns 0 matches"
depends_on:
  - TASK-690
estimated_complexity: high
epic: cyboflow-shell-architecture
test_strategy:
  needed: false
  justification: "Pure deletion sweep. Deleted files have no co-located test specs (verified: no frontend/src/components/session/__tests__/, no Session* test files). Existing test suites (RunView, useAddTerminalShortcut, Sidebar.mcpHealth, reviewQueue stores) do NOT import any deleted module. Typecheck-green + lint-green + grep-zero gates are the correctness contract."
---
# Delete SessionView and unreachable Crystal-era session descendants

## Objective

After TASK-690 removes the `<SessionView />` mount point, this task deletes `SessionView.tsx` and the descendant components/hooks/stores whose only import path was through SessionView. The deletion is conservative: every candidate was verified by grep to have zero remaining importers. Components that look session-coupled but are mounted under the panel system via `PanelContainer` → `CliPanelFactory` → `ClaudePanel` (or used by `DraggableProjectTreeView`/`ProjectTreeView`) are preserved.

## Implementation Steps

1. **Pre-flight verification grep (run BEFORE deleting):**
   ```
   grep -rn 'SessionView' frontend/src/
   grep -rn 'useSessionView' frontend/src/
   grep -rnE "from\s+['\"][^'\"]*(session/SessionHeader|session/SessionInput|session/RichOutputSettingsPanel|session/GitErrorDialog|session/FolderArchiveDialog|session/CommitMessageDialog|StravuFileSearch|sessionHistoryStore)" frontend/src/
   ```
   If any match exists in a file NOT in `files_owned`, STOP and escalate — TASK-690 didn't fully land or audit missed a consumer.

2. **Verify preservation set is still reachable from active surfaces.** Each pattern in the "preservation" verification must return ≥1 match from a non-deleted file.

3. **Delete the SessionView surface files** (`git rm`):
   - `frontend/src/components/SessionView.tsx`
   - `frontend/src/components/StravuFileSearch.tsx`
   - `frontend/src/components/session/SessionHeader.tsx`
   - `frontend/src/components/session/SessionInput.tsx`
   - `frontend/src/components/session/RichOutputSettingsPanel.tsx`
   - `frontend/src/components/session/GitErrorDialog.tsx`
   - `frontend/src/components/session/FolderArchiveDialog.tsx`
   - `frontend/src/components/session/CommitMessageDialog.tsx`
   - `frontend/src/hooks/useSessionView.ts`
   - `frontend/src/stores/sessionHistoryStore.ts`

4. **Update `docs/CODE-PATTERNS.md`** — remove the `frontend/src/components/SessionView.tsx:14` (import-line) canonical example; keep the method-group example.

5. **Update `main/src/services/worktreeManager.ts:502-505`** `@cyboflow-hidden` comment:
   ```
   // @cyboflow-hidden: The following methods (rebaseMainIntoWorktree, abortRebase,
   // squashAndMergeWorktreeToMain, mergeWorktreeToMain) are intentionally preserved but
   // not exposed in the v1 UI. The legacy SessionView surface that wired them was
   // retired (IDEA-017 / TASK-691). Re-enable by adding branch action entries to a
   // future workflow-run / session UI in the cyboflow shell.
   ```

6. **Run typecheck + lint gates.** Both must exit 0. If `typecheck` reports a missing-module error, the consumer was missed in step 1's grep — find it.

7. **Run `pnpm test:unit`.** Must exit 0.

8. **Re-run completeness grep** as final gate.

9. **Visual smoke.** `pnpm dev`. App should launch, render CyboflowRoot, produce no console errors mentioning missing modules.

## Scope Deferred

- **`frontend/src/components/ProjectView.tsx` deletion** — only importer was deleted SessionView, but deleting cascades into the entire `panels/` subtree (17+ files). High-blast; likely partially repurposed by new shell. File a follow-up.
- **Main-process session-only IPC handlers** — orphaned on renderer side but main-process handlers still exist. Per decomposer directive, deferred. Keeping types + handlers paired preserves IPC parity.
- **`sessionStore.ts` slimming** — still consumed by 13+ active files (Sidebar tree, App.tsx, useIPCEvents, etc.). Defer field-level dead-code analysis.
- **`SessionListItem.tsx` deletion** — contingent on sidebar information-model decision.
- **DB tables** — TASK-692 owns.

## Acceptance Criteria

See frontmatter.

## Test Strategy

No new tests. Deleted files have no co-located specs. Active test suites don't import any deleted module. Correctness enforced by typecheck-green + grep-zero + visual smoke.

## Hardest Decision

**Whether to delete `ProjectView.tsx` and the `panels/` subtree as part of this sweep.** ProjectView is post-TASK-690 unreachable, but the `panels/` subtree is 17+ files exceeding what one atomic commit can safely cover; IDEA-017 slices 4 + sidebar-info-model decisions may repurpose panels rather than delete; the decomposer's `files_owned_hint` did NOT include ProjectView. Chose to defer, explicitly enumerated in Scope Deferred.

## Rejected Alternatives

- **Delete session-only IPC channel declarations from electron.d.ts/api.ts in this task.** Rejected — matching handlers stay, would violate IPC parity rules.
- **Delete `sessionStore.ts` outright.** Rejected — 13 active files consume it; proving deadness is its own audit.
- **Delete entire `frontend/src/components/session/` directory.** Rejected — `session/ThinkingPlaceholder.tsx` is imported by an active panel.

## Lowest Confidence Area

The TASK-690 boundary. If TASK-690 only removed the mount + toggle but left the `import` line, step 1's grep finds a stale match and step 6's typecheck fails. Mitigation: stop and escalate before deleting if any non-deletion-set file matches.
