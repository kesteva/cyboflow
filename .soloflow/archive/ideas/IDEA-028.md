---
id: IDEA-028
type: FEATURE
status: answered
created: 2026-05-27T00:00:00Z
slices:
  - title: "Session Lifecycle Action Bar"
    description: "Add Merge, Create PR, and Dismiss buttons/menu to the session panel header in CyboflowRoot. The action bar is present on all non-archived, non-main-repo sessions."
    value_statement: "Users can see and trigger lifecycle actions directly from the session they are reviewing, without navigating away."
  - title: "Local Merge Action"
    description: "Wire the Merge button to the existing `sessions:squash-and-rebase-to-main` and `sessions:rebase-to-main` IPC handlers (which delegate to WorktreeManager's `@cyboflow-hidden` methods). Offer a choice: squash merge (single commit) or preserve commits. After success, auto-cleanup the worktree by calling `sessions:delete`."
    value_statement: "Users can land worktree changes into main locally without leaving the app, with the worktree cleaned up automatically."
  - title: "Create PR Action"
    description: "Wire the Create PR button to push the branch (`sessions:git-push`) then open a pre-filled GitHub/GitLab PR creation URL in the system browser. After the push completes, auto-cleanup the worktree."
    value_statement: "Users can ship a PR from any session in one click, with the worktree cleaned up so the session list stays tidy."
  - title: "Dismiss Action with Confirmation"
    description: "Wire the Dismiss button to display a `ConfirmDialog` warning about unmerged changes, then call `sessions:delete` (which archives the session and removes the worktree). Confirmation is always required."
    value_statement: "Users can close out abandoned sessions and reclaim worktree disk space safely without accidental data loss."
open_questions:
  - question: "Where exactly in the CyboflowRoot layout should the action bar live?"
    context: "The session panel header is described as the target in the brief. CyboflowRoot has a thin top header row (px-4 py-2) that currently holds 'Choose workflow' and 'Quick Session' buttons. The right rail is RunRightRail. There is no per-session header strip below the top bar. A dedicated strip needs to be added or the actions need to slot into the existing top row conditionally."
    answer: "Inject the action buttons into the existing CyboflowRoot top bar row, conditionally when an active run / session exists"
    candidates:
      - "Add a new per-session header strip immediately above the PanelTabBar (inside the bottom panel surface area)"
      - "Inject the action buttons into the existing CyboflowRoot top bar row, conditionally when an active run / session exists"
      - "Place the actions in RunRightRail as a dedicated 'Session Actions' section above the tab bar"
  - question: "For the local merge action, should the user choose squash-merge vs. preserve-commits, or should one be the default?"
    context: "WorktreeManager exposes both `squashAndMergeWorktreeToMain` and `mergeWorktreeToMain`. The IPC handlers `sessions:squash-and-rebase-to-main` and `sessions:rebase-to-main` already exist. Offering both adds UI complexity; defaulting to squash is the cleaner UX but loses history."
    answer: "Present both as equal options in the Merge flow dialog"
    candidates:
      - "Default to squash merge; no choice offered"
      - "Default to squash merge; offer an advanced toggle to preserve commits"
      - "Present both as equal options in the Merge flow dialog"
  - question: "For Create PR, which git hosting provider(s) should be auto-detected?"
    context: "The codebase has no existing GitHub/GitLab API integration or remote-URL parsing. The simplest implementation pushes the branch and opens a browser URL constructed from the remote origin URL. The remote origin might be GitHub, GitLab, Bitbucket, or self-hosted."
    answer: "GitHub only (parse `github.com` in remote URL, construct `/compare` URL)"
    candidates:
      - "GitHub only (parse `github.com` in remote URL, construct `/compare` URL)"
      - "GitHub + GitLab (parse both domains)"
      - "Any remote: push the branch and show the user the branch name with a 'copy URL' fallback if provider is unrecognized"
  - question: "After a successful Merge or Create PR, should the session panel close immediately or show a success state before closing?"
    context: "Auto-cleanup means calling `sessions:delete` which archives and removes the worktree. The session will disappear from the active list. The user may want a brief success confirmation before it vanishes."
    answer: "Show a brief success toast/banner for 2-3 seconds, then close"
    candidates:
      - "Close immediately after success (session disappears from list)"
      - "Show a brief success toast/banner for 2-3 seconds, then close"
      - "Show an in-panel success state; user manually dismisses to close"
  - question: "Should the action bar be visible when Claude is still actively running in the session?"
    context: "If Claude is mid-run, merging could capture incomplete work. The session status is available as `activeSession.status` in ClaudePanel."
    answer: "Show actions but disable Merge and Create PR when status is 'running'; Dismiss always enabled"
    candidates:
      - "Show actions but disable Merge and Create PR when status is 'running'; Dismiss always enabled"
      - "Hide the action bar entirely while status is 'running'"
      - "Show all actions with a warning badge when status is 'running'"
assumptions:
  - assumption: "The `@cyboflow-hidden` WorktreeManager methods (`squashAndMergeWorktreeToMain`, `mergeWorktreeToMain`) and their IPC handlers (`sessions:squash-and-rebase-to-main`, `sessions:rebase-to-main`) are complete and functional — they only lack a UI surface."
    confidence: high
    validation: "Confirmed by worktreeManager.ts line 502-506 comment: 'Re-enable by adding branch action entries to a future workflow-run / session UI.' The IPC handlers exist in main/src/ipc/git.ts and the API wrappers exist in frontend/src/utils/api.ts."
  - assumption: "The `sessions:delete` IPC handler handles worktree cleanup correctly and can be called post-merge without side effects."
    confidence: high
    validation: "Reviewed main/src/ipc/session.ts lines 448-558: the handler archives the session, removes the worktree via worktreeManager.removeWorktree, and cleans up artifacts. It guards against double-archive."
  - assumption: "The `sessions:git-push` IPC handler can push the worktree branch without requiring any additional auth configuration beyond what the user already has for git."
    confidence: medium
    validation: "The handler exists in main/src/ipc/git.ts (line 1162). Authentication depends on the user's git credential config. SSH keys / credential helpers are pass-through from the environment. Test against a real project with a remote to confirm."
  - assumption: "A GitHub PR creation URL can be constructed from the remote origin URL without an API token — the /compare/{branch} URL pattern opens a browser pre-fill page."
    confidence: high
    validation: "GitHub, GitLab, and Bitbucket all support browser-based PR creation URLs. No API token needed for URL construction; the push (handled by sessions:git-push) is what requires credentials."
  - assumption: "The session action bar should only appear for worktree sessions (is_main_repo === false) since merging the main repo session into itself is nonsensical."
    confidence: high
    validation: "WorktreeManager merge methods guard with project + worktree path logic. main/src/ipc/session.ts line 481 checks `!dbSession.is_main_repo` before removing worktree. Frontend session objects carry `isMainRepo` flag."
  - assumption: "The existing `ConfirmDialog` component in frontend/src/components/ConfirmDialog.tsx is suitable for the Dismiss confirmation without modification."
    confidence: high
    validation: "Reviewed the component: it accepts title, message, confirmText, cancelText, confirmButtonClass, and icon props. Structurally adequate for a destructive action warning."
research_recommendation: not_needed
research_rationale: "All backend merge/cleanup/push machinery already exists in the codebase; the work is surfacing it with a new UI strip and wiring existing IPC handlers. No unfamiliar technology or external API integration is required beyond a simple URL construction for PR creation."
---

# Session Lifecycle Actions (Merge, Create PR, Dismiss)

## Raw Input

> existing sessions need a place to merge or dismiss that session which either prompts to merge in, create a PR, or close out that session and clean up that worktree.

## Grounding

**Backend — merge/cleanup machinery (all `@cyboflow-hidden`, awaiting UI surface):**
- `main/src/services/worktreeManager.ts` — lines 502-506 contain the explicit `@cyboflow-hidden` annotation: *"Re-enable by adding branch action entries to a future workflow-run / session UI in the cyboflow shell."* The methods `squashAndMergeWorktreeToMain` (line 592) and `mergeWorktreeToMain` (line 743) are complete.
- `main/src/ipc/git.ts` — IPC handlers `sessions:squash-and-rebase-to-main` (line 915) and `sessions:rebase-to-main` (line 1004) are registered and fully implemented. Also `sessions:git-push` (line 1162).
- `main/src/ipc/session.ts` — `sessions:delete` (line 448) handles archive + worktree removal + artifact cleanup, with background progress tracking via `archiveProgressManager`.

**Frontend API wrappers (all present, no new IPC needed for merge/push/delete):**
- `frontend/src/utils/api.ts` — `API.sessions.squashAndRebaseToMain` (line 209), `API.sessions.rebaseToMain` (line 214), `API.sessions.gitPush` (line 256), `API.sessions.delete` (line 76).

**UI — where the header bar lives:**
- `frontend/src/components/cyboflow/CyboflowRoot.tsx` — top header row (line 72) holds workflow picker and quick session buttons. Panel surface mounts `PanelTabBar` + `PanelContainer` below. No per-session header strip currently exists.
- `frontend/src/components/cyboflow/RunRightRail.tsx` — right rail with Workflow Progress, File Explorer (placeholder), Diff (placeholder) tabs.
- `frontend/src/components/panels/claude/ClaudePanel.tsx` — the session panel itself; has a conditional debug header (lines 101-165) but no lifecycle action bar.

**Existing dialog primitives:**
- `frontend/src/components/ConfirmDialog.tsx` — destructive-action confirmation dialog; takes title, message, confirmText, cancelText props.
- `frontend/src/components/ui/Modal.tsx` — general modal shell with ModalHeader/ModalBody/ModalFooter.
- `frontend/src/components/CommitDialog.tsx` — example of a git-action dialog with message input.
- `frontend/src/components/MainBranchWarningDialog.tsx` — example of a multi-button decision dialog pattern.

**GitStatusIndicator for context:**
- `frontend/src/components/GitStatusIndicator.tsx` — shows ahead/behind/uncommitted state; relevant for deciding whether to warn about unmerged commits on dismiss.

## Slices

### Slice 1: Session Lifecycle Action Bar

Add a UI strip to the session panel header area in CyboflowRoot. The strip renders for non-archived, non-main-repo sessions and displays three action buttons: Merge, Create PR, and Dismiss. The exact placement (above PanelTabBar, injected into the top row, or in RunRightRail) is an open question for the task refiner.

The strip receives the `sessionId` and `isMainRepo` flag and disables or hides itself for main-repo sessions and archived sessions. Button enabled/disabled state respects the active session's run status (see open question on running sessions).

### Slice 2: Local Merge Action

When the user clicks Merge, a dialog opens offering the merge strategy (squash-merge or preserve-commits — exact choice per open question). After the user confirms:

1. Call `API.sessions.squashAndRebaseToMain(sessionId, commitMessage)` or `API.sessions.rebaseToMain(sessionId)` depending on the selected strategy.
2. On success, call `API.sessions.delete(sessionId)` to archive and remove the worktree.
3. Navigate away or show success state (per open question).

Errors (merge conflicts, git failures) surface via an error dialog; the session is NOT deleted on failure.

### Slice 3: Create PR Action

When the user clicks Create PR:

1. Call `API.sessions.gitPush(sessionId)` to push the worktree branch to the remote.
2. Parse the remote origin URL from the session's git info to determine the branch name.
3. Construct a PR-creation URL for the detected provider (GitHub `/compare/{branch}`, GitLab `/merge_requests/new`, etc.) and open it via shell open.
4. On push success, call `API.sessions.delete(sessionId)` to auto-cleanup.

If the remote cannot be parsed or is an unrecognized provider, show a fallback with the branch name and remote URL for the user to act on manually.

### Slice 4: Dismiss Action with Confirmation

When the user clicks Dismiss, `ConfirmDialog` always opens with:
- Title: "Dismiss session?"
- Message: warns explicitly that unmerged changes will be lost and the worktree removed.
- Confirm button: "Dismiss" (destructive style, red).

On confirm, call `API.sessions.delete(sessionId)`. The existing `sessions:delete` handler handles archiving and worktree removal. No special new logic needed in the backend.

## Open Questions

**Q1: Where exactly in the CyboflowRoot layout should the action bar live?**
**Answer:** Inject the action buttons into the existing CyboflowRoot top bar row, conditionally when an active run / session exists.

**Q2: For the local merge action, should the user choose squash-merge vs. preserve-commits?**
**Answer:** Present both as equal options in the Merge flow dialog.

**Q3: For Create PR, which git hosting providers should be auto-detected?**
**Answer:** GitHub only (parse `github.com` in remote URL, construct `/compare` URL).

**Q4: After successful Merge or Create PR, should the session panel close immediately or show a success state?**
**Answer:** Show a brief success toast/banner for 2-3 seconds, then close.

**Q5: Should the action bar be visible when Claude is still actively running in the session?**
**Answer:** Show actions but disable Merge and Create PR when status is 'running'; Dismiss always enabled.

## Assumptions

- The `@cyboflow-hidden` WorktreeManager methods and their IPC handlers are production-ready — they only lack a UI surface.
- `sessions:delete` is safe to call immediately after a successful merge.
- `sessions:git-push` relies on the user's existing git credential config.
- A browser-opened PR creation URL requires no API token.
- The action bar should only render for `isMainRepo === false` sessions.
- `ConfirmDialog` is adequate for the Dismiss confirmation without changes.
