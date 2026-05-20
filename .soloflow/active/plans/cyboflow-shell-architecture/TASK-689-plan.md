---
id: TASK-689
idea: IDEA-017
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - frontend/src/components/CreateSessionDialog.tsx
  - frontend/src/components/CreateSessionButton.tsx
  - frontend/src/components/ProjectTreeView.tsx
  - frontend/src/components/DraggableProjectTreeView.tsx
  - frontend/src/components/panels/SetupTasksPanel.tsx
files_readonly:
  - frontend/src/components/Sidebar.tsx
  - frontend/src/components/SessionListItem.tsx
  - frontend/src/hooks/useSessionView.ts
  - frontend/src/components/panels/PanelContainer.tsx
  - frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx
  - docs/crystal-legacy/FEATURE_USAGE_TRACKING_INTEGRATION.md
acceptance_criteria:
  - criterion: "frontend/src/components/CreateSessionDialog.tsx no longer exists on disk."
    verification: "test ! -f frontend/src/components/CreateSessionDialog.tsx"
  - criterion: "frontend/src/components/CreateSessionButton.tsx no longer exists on disk."
    verification: "test ! -f frontend/src/components/CreateSessionButton.tsx"
  - criterion: "frontend/src/components/ProjectTreeView.tsx no longer exists on disk (legacy unused duplicate)."
    verification: "test ! -f frontend/src/components/ProjectTreeView.tsx"
  - criterion: "No source file under frontend/src/ references the identifier CreateSessionDialog."
    verification: "grep -rn --include='*.ts' --include='*.tsx' 'CreateSessionDialog' frontend/src/ ; expect 0 matches"
  - criterion: "No source file under frontend/src/ references the identifier CreateSessionButton."
    verification: "grep -rn --include='*.ts' --include='*.tsx' 'CreateSessionButton' frontend/src/ ; expect 0 matches"
  - criterion: "DraggableProjectTreeView no longer carries the play-button JSX, handleCreateSession/handleQuickAddSession handlers, showCreateDialog state, selectedProjectForCreate state, retrySessionData state, discard-and-retry listener, or Cmd/Ctrl+Shift+N quick-session keyboard listener."
    verification: "grep -nE 'handleCreateSession|handleQuickAddSession|showCreateDialog|setShowCreateDialog|selectedProjectForCreate|retrySessionData|setRetrySessionData|discard-and-retry|Cmd/Ctrl \\+ Shift \\+ N' frontend/src/components/DraggableProjectTreeView.tsx returns 0 matches"
  - criterion: "SetupTasksPanel no longer imports or mounts CreateSessionDialog."
    verification: "grep -nE 'CreateSessionDialog|showSessionDialog|setShowSessionDialog' frontend/src/components/panels/SetupTasksPanel.tsx returns 0 matches"
  - criterion: "Repository-wide typecheck passes."
    verification: "pnpm typecheck exits 0"
  - criterion: "Repository-wide lint passes."
    verification: "pnpm lint exits 0"
depends_on: [TASK-687]
estimated_complexity: medium
epic: cyboflow-shell-architecture
test_strategy:
  needed: false
  justification: "No sibling tests reference CreateSessionDialog / CreateSessionButton / the play-button affordance. Sidebar.mcpHealth.test.tsx mocks DraggableProjectTreeView via vi.mock so its rendered surface is irrelevant. No new test is needed — change is a deletion sweep verified by grep ACs plus existing pnpm typecheck/lint gates."
---

# Cut CreateSessionDialog, CreateSessionButton, and Crystal session-creation triggers from the sidebar

## Objective

Delete the Crystal-era session-creation surfaces: `CreateSessionDialog.tsx`, `CreateSessionButton.tsx`, the unused legacy duplicate `ProjectTreeView.tsx`, the play-button affordance + related state/handlers in `DraggableProjectTreeView.tsx`, and the orphaned import/mount in `SetupTasksPanel.tsx`. After this task, no source file under `frontend/src/` mentions either identifier, and the project-tree row no longer exposes a "New Session" play button. Resolves the user-flagged "start run experience" dialog from 2026-05-18 manual testing.

## Implementation Steps

1. **Completeness gate (run first, repeat at end):**
   ```
   grep -rln --include='*.ts' --include='*.tsx' -E 'CreateSessionDialog|CreateSessionButton' frontend/src/
   ```
   MUST return exactly: `CreateSessionDialog.tsx`, `CreateSessionButton.tsx`, `ProjectTreeView.tsx`, `DraggableProjectTreeView.tsx`, `SetupTasksPanel.tsx`. If new file appears, STOP and reconcile against sibling task boundaries.

2. **Delete `frontend/src/components/CreateSessionDialog.tsx`** entirely (`git rm`).

3. **Delete `frontend/src/components/CreateSessionButton.tsx`** entirely. Audit confirms no remaining callers.

4. **Delete `frontend/src/components/ProjectTreeView.tsx`** entirely. Unreferenced legacy duplicate; Sidebar.tsx only imports `DraggableProjectTreeView`.

5. **Scrub `frontend/src/components/DraggableProjectTreeView.tsx`** of all CreateSession references:
   - Line 7: remove `import { CreateSessionDialog }`.
   - Line 99: remove `showCreateDialog` state.
   - Line 100: remove `selectedProjectForCreate` state.
   - `retrySessionData` state block: remove.
   - Lines 510-533: remove `useEffect` for `Cmd/Ctrl + Shift + N`.
   - Lines 594-633: remove `useEffect` registering `discard-and-retry` listener.
   - Lines 1120-1158: remove `handleCreateSession` and `handleQuickAddSession` functions.
   - Lines 2175-2190: remove the "New Session" play-button JSX (verify `Plus` icon usage; remove import if orphaned).
   - Lines 2456-2482: remove `{showCreateDialog && <CreateSessionDialog .../>}` mount.
   - Lines 2775-2790: remove folder-context-menu "New Session Here" button (Rename/Delete stay).
   - Run `pnpm typecheck` to surface unused imports.

6. **Scrub `frontend/src/components/panels/SetupTasksPanel.tsx`:**
   - Line 7: remove `import { CreateSessionDialog }`.
   - Line 30: remove `showSessionDialog` state.
   - Lines 449-461: remove `<CreateSessionDialog ...>` mount + trailing comment.
   - Audit for any remaining `setShowSessionDialog(true)` call sites; replace with stub comment `// TODO(TASK-691): SetupTasksPanel will be deleted with the SessionView retirement`.
   - Do NOT delete the panel itself — TASK-691 owns that.

7. **Run completeness gate again:**
   ```
   grep -rn --include='*.ts' --include='*.tsx' -E 'CreateSessionDialog|CreateSessionButton' frontend/src/
   ```
   Expected: zero matches.

8. **Verify build health.** `pnpm typecheck` and `pnpm lint`; both must exit 0.

## Acceptance Criteria

See frontmatter `acceptance_criteria`.

## Test Strategy

No new tests. Behavior change is absence of UI surface, asserted directly by grep ACs. Directory-level sibling-test scan turned up no test files coupled to the deleted surfaces. `pnpm typecheck` and `pnpm lint` plus grep ACs cover the regression surface fully.

## Hardest Decision

**Re-claiming `DraggableProjectTreeView.tsx` as `files_owned` despite the decomposer marking it `files_readonly_hint`.** Eight scattered surgical edits aren't a "tiny edit window". Option A (re-claim) is honest about the conflict; the `depends_on: [TASK-687]` ordering ensures TASK-687's tree-shape remodel lands first, eliminating worktree merge collision. Same reasoning applies to claiming `SetupTasksPanel.tsx` — deleting `CreateSessionDialog.tsx` immediately breaks the SetupTasksPanel import, and `depends_on` says TASK-690 runs before TASK-691, so the broken import would block TASK-690's typecheck.

## Rejected Alternatives

- **Option B (keep `DraggableProjectTreeView.tsx` readonly, only touch play-button JSX).** Rejected — leaves dead handlers/state behind, violates "no half-Crystal half-cyboflow" goal.
- **Leave `SetupTasksPanel.tsx` alone and let TASK-691 delete it.** Rejected — broken import blocks TASK-690's typecheck.
- **`@cyboflow-hidden`-mark the files.** Rejected — this is a deletion slice, not a preservation slice.

## Lowest Confidence Area

**Whether removing the `Cmd/Ctrl+Shift+N` global keyboard listener and the `discard-and-retry` event listener belongs here or in TASK-691.** The decomposer's scope summary names only `handleCreateSession`/`handleQuickAddSession`/`showCreateDialog` explicitly. Both listeners' only effect is to *trigger* the deleted handlers/dialog, so leaving them creates silent dead code. My read: they fall under "the play-button trigger" in spirit. Fallback if executor finds them load-bearing: leave as no-op stubs with `TODO(TASK-691)` comment.
