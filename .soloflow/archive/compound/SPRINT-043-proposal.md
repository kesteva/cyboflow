---
sprints: [SPRINT-043]
span_label: SPRINT-043
created: 2026-05-27T00:00:00Z
counters_start:
  ideas: 24
summary:
  cleanups: 1
  backlog_tasks: 2
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-043

## A. Clean-up items (execute now)

### A1. Add error handling to SessionDismissDialog.handleConfirm
- **Summary:** `SessionDismissDialog` silently swallows `API.sessions.delete` errors — wrap the call in a try/catch that surfaces failures via `useErrorStore`, matching the pattern in `SessionMergeDialog` and `SessionCreatePrDialog`.
- **Source-Sprint:** SPRINT-043
- **Rationale:** The bug is a one-line oversight introduced in TASK-795 and identified by the sprint code-reviewer (FIND-SPRINT-043-2). The two sibling dialogs (TASK-793, TASK-794) already follow the correct pattern; the inconsistency will confuse users when a delete fails silently, leaving the session open with no feedback. The fix is a trivial try/catch around three lines of code — no new API surface, no state changes needed beyond what already exists.
- **Blast radius:** `frontend/src/components/cyboflow/SessionDismissDialog.tsx` only. Risk: trivial.
- **Source:** FIND-SPRINT-043-2 (sprint-code-reviewer); TASK-795 implementation.
- **Proposed change:**
  ```diff
  --- a/frontend/src/components/cyboflow/SessionDismissDialog.tsx
  +++ b/frontend/src/components/cyboflow/SessionDismissDialog.tsx
  -import { useCallback } from 'react';
  +import { useCallback, useState } from 'react';
   import { AlertTriangle } from 'lucide-react';
   import { ConfirmDialog } from '../ConfirmDialog';
   import { API } from '../../utils/api';
  +import { useErrorStore } from '../../stores/errorStore';

   interface SessionDismissDialogProps {
     isOpen: boolean;
     onClose: () => void;
     sessionId: string;
     onSuccess?: () => void;
   }

   export function SessionDismissDialog({ isOpen, onClose, sessionId, onSuccess }: SessionDismissDialogProps) {
  -  const handleConfirm = useCallback(() => {
  -    void API.sessions.delete(sessionId).then(() => {
  -      onSuccess?.();
  -    });
  -  }, [sessionId, onSuccess]);
  +  const [isDismissing, setIsDismissing] = useState(false);
  +
  +  const handleConfirm = useCallback(async () => {
  +    setIsDismissing(true);
  +    try {
  +      await API.sessions.delete(sessionId);
  +      onSuccess?.();
  +      onClose();
  +    } catch (err) {
  +      useErrorStore.getState().showError({
  +        title: 'Dismiss failed',
  +        error: err instanceof Error ? err.message : String(err),
  +      });
  +    } finally {
  +      setIsDismissing(false);
  +    }
  +  }, [sessionId, onSuccess, onClose]);
  ```
  Also update the `SessionDismissDialog.test.tsx` to add a test case: "confirm flow: on delete failure calls showError and does NOT call onSuccess". Update the existing "clicking confirm" test to use `await` on the confirm handler. The `isDismissing` state can be threaded into the `ConfirmDialog` confirm-button loading state if `ConfirmDialog` exposes that prop; otherwise the error-handling fix alone is the required change.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Wire session lifecycle dialogs to the action bar callbacks in CyboflowRoot
- **Summary:** `SessionLifecycleActionBar` is rendered in `CyboflowRoot` with no callbacks wired — the Merge, Create PR, and Dismiss buttons are all no-ops; the three dialog components built in TASK-793..795 are unreachable from the UI.
- **Source-Sprint:** SPRINT-043
- **Source:** FIND-SPRINT-043-1 (sprint-code-reviewer); TASK-792, TASK-793, TASK-794, TASK-795 implementation; CyboflowRoot.tsx line 94 (`<SessionLifecycleActionBar />`).
- **Problem:** `CyboflowRoot.tsx:94` renders `<SessionLifecycleActionBar />` with no props. All three callback props (`onMerge`, `onCreatePR`, `onDismiss`) default to `undefined`, making the buttons no-ops. `SessionMergeDialog`, `SessionCreatePrDialog`, and `SessionDismissDialog` are each exported and tested but never imported or rendered outside their own files. The `SessionActionToast` component also has no mount point. This is the missing integration glue that connects the shell (TASK-792) to the implementations (TASK-793..795) — the entire session lifecycle flow is built but non-functional end to end.
- **Proposed direction:** Create a follow-up task that modifies `CyboflowRoot.tsx` to: (1) import all three dialogs and `SessionActionToast`; (2) add three `isOpen` boolean state variables and a `toastMessage` string state; (3) pass open-dialog callbacks to `SessionLifecycleActionBar` (`onMerge`, `onCreatePR`, `onDismiss`); (4) render each dialog with `isOpen`, `onClose`, `sessionId` (derived from `activeQuickSessionId`), and `onSuccess` callbacks that set the toast message; (5) render `SessionActionToast` with `isVisible` + `onDismiss`. The `activeQuickSessionId` from `useCyboflowStore` and the resolved session from `useSessionStore` (already wired in `SessionLifecycleActionBar`) should be lifted up into `CyboflowRoot` to avoid double store reads. Unit test updates to `CyboflowRoot.test.tsx` should cover the open/close cycle for each dialog.
- **Scope:** small

### B2. Investigate and document whether `settingSources: ['user', 'project']` may bypass ApprovalRouter for workflow runs
- **Summary:** TASK-785 changed `settingSources` from `['project']` to `['user', 'project']` in `claudeCodeManager.ts`, removing the isolation that the deleted comment explicitly documented — a technical decision with real security implications that needs either a verification pass or an explicit documented acceptance of the risk.
- **Source-Sprint:** SPRINT-043
- **Source:** FIND-SPRINT-043-3 (sprint-code-reviewer); TASK-785 implementation; `main/src/services/panels/claude/claudeCodeManager.ts:431`.
- **Problem:** The original `settingSources: ['project']` was intentional isolation: the deleted comment read "Isolate from ~/.claude/settings.json: the user's interactive-mode permission rules (e.g. defaultMode: 'auto' + Bash(...) allow list) would auto-approve tools without firing our PreToolUse hook, bypassing ApprovalRouter and skipping the approval queue entirely." TASK-785 adds `'user'` back to fix a real UX problem (user-level MCP servers and custom instructions not loading), but re-opens the path where user-level tool allow-lists in `~/.claude/settings.json` cause the SDK to auto-approve tools before `PreToolUse` fires. No replacement comment, no audit of the SDK's allow-list precedence rules, and no test coverage of the bypass scenario was added.

  The actual risk depends on whether the SDK's `PreToolUse` hook takes unconditional precedence over settings-file allow-lists, or whether settings-file allow-lists can shortcut the hook. This needs a definitive answer from the Claude Agent SDK documentation or a targeted test. If bypass is possible, the task should either investigate whether `settingSources` supports a more surgical option (e.g. loading MCP config without permission rules) or document the accepted trade-off with a comment at the call site that replaces the one deleted by TASK-785.
- **Scope:** small

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the `settingSources` trade-off in `docs/CODE-PATTERNS.md` under the `permissionMode contract` section
- **Summary:** Add a note under the existing `permissionMode contract` pattern in `docs/CODE-PATTERNS.md` that documents the `settingSources: ['user', 'project']` decision, the ApprovalRouter bypass risk, and the mitigation (PreToolUse hook omission when `permissionMode === 'ignore'`), so future agents touching `claudeCodeManager.ts` do not re-introduce the old isolation silently.
- **Source-Sprint:** SPRINT-043
- **Target file:** `docs/CODE-PATTERNS.md`
- **Rationale:** FIND-SPRINT-043-3 observed that TASK-785 deleted a critical comment explaining the isolation rationale with no replacement. The `permissionMode contract` section in `CODE-PATTERNS.md` (around line 458) already owns the ApprovalRouter/PreToolUse rules and is the right place to cross-link the `settingSources` decision. Without this note, the next agent to touch `buildSdkOptions()` in `claudeCodeManager.ts` will see `settingSources: ['user', 'project']` with no comment and will either not understand the trade-off or will re-add `['project']`-only isolation to "fix" a perceived gap.
- **Proposed change:** Insert after the existing rule 5 in the `permissionMode contract` section (after line 477, before the closing paragraph):

  ```diff
  +
  +6. **`settingSources` in `buildSdkOptions` is `['user', 'project']` — this is intentional.**
  +   Loading user settings from `~/.claude/settings.json` is needed to pick up user-level MCP
  +   servers, custom instructions, and other per-user configuration. The acknowledged risk is
  +   that user-level tool allow-lists (e.g. `defaultMode: 'auto'` + a `Bash(...)` allow entry)
  +   could cause the SDK to auto-approve tools before the `PreToolUse` hook fires, bypassing
  +   `ApprovalRouter`. This risk is mitigated by the conditional hook registration in
  +   `claudeCodeManager.ts buildSdkOptions()`: when `permissionMode === 'ignore'` the
  +   `PreToolUse` hook is omitted entirely (tools auto-approved by design), and when
  +   `permissionMode === 'approve'` the hook is registered unconditionally. Do NOT revert
  +   `settingSources` to `['project']`-only without also removing the user-settings UX
  +   features that depend on it. If SDK behaviour around allow-list precedence needs
  +   clarification, check the Claude Agent SDK docs for `PreToolUse` hook priority vs
  +   settings-file allow-lists.
  ```

---

## Reconciled Findings (informational)

No done reports for SPRINT-043 tasks were found in `.soloflow/archive/done/` at compound time (plans are present and marked `status: done` but the sprint-closer archival step has not run or the done reports were not enumerated in the orchestrator handoff). All three findings — FIND-SPRINT-043-1, FIND-SPRINT-043-2, FIND-SPRINT-043-3 — carry `status: open` with no `resolved_by` field set, and no done report claims resolution of any of them. They are triaged above as genuinely open.
