---
sprint: SPRINT-043
pending_count: 0
last_updated: "2026-05-28T00:30:26.166Z"
---
# Findings Queue

## FIND-SPRINT-043-1
- **source:** SPRINT-043 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/cyboflow/CyboflowRoot.tsx:94
- **description:** Session lifecycle dialogs unreachable — all four components (SessionMergeDialog, SessionCreatePrDialog, SessionDismissDialog, SessionActionToast) are exported but never imported or rendered outside their own files and tests. SessionLifecycleActionBar is rendered in CyboflowRoot at line 94 but with no callbacks wired:
- **suggested_action:** Add a follow-up task that imports the three dialogs into CyboflowRoot, manages their isOpen state, and passes the open-dialog callbacks to SessionLifecycleActionBar. This is the missing integration glue that connects the shell (TASK-792) to the implementations (TASK-793..795).
- **resolved_by:** 



<SessionLifecycleActionBar />

All three callback props (onMerge, onCreatePR, onDismiss) default to undefined, making the Merge, Create PR, and Dismiss buttons no-ops. No task in the epic wires the dialogs to the action bar.

Suspected tasks: TASK-792, TASK-793, TASK-794, TASK-795

## FIND-SPRINT-043-2
- **source:** SPRINT-043 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/cyboflow/SessionDismissDialog.tsx:14
- **description:** SessionDismissDialog silently swallows API.sessions.delete errors — inconsistent with sibling dialogs. handleConfirm fires delete as fire-and-forget with no .catch():
- **suggested_action:** Wrap the API.sessions.delete call in SessionDismissDialog in a try/catch that calls useErrorStore.getState().showError() on failure, matching the error-handling pattern in SessionMergeDialog and SessionCreatePrDialog.
- **resolved_by:** 


void API.sessions.delete(sessionId).then(() => {
  onSuccess?.();
});

SessionMergeDialog (TASK-793) and SessionCreatePrDialog (TASK-794) both wrap their delete calls in try/catch with useErrorStore.getState().showError(). A network or server error in SessionDismissDialog closes the dialog silently, leaving the session un-deleted with no user feedback.

Suspected tasks: TASK-793, TASK-794, TASK-795

## FIND-SPRINT-043-3
- **source:** SPRINT-043 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:431
- **description:** settingSources change removes ApprovalRouter bypass protection without replacement documentation. TASK-785 changed settingSources from ["project"] to ["user", "project"], removing the isolation that the deleted comment explicitly documented:

// Isolate from ~/.claude/settings.json: the user's interactive-mode
// permission rules (e.g. defaultMode: 'auto' + Bash(...) allow list)
// would auto-approve tools without firing our PreToolUse hook, bypassing
// ApprovalRouter and skipping the approval queue entirely.

Adding "user" re-enables the path where user-level tool allow-lists cause the SDK to auto-approve tools before the PreToolUse hook fires, potentially bypassing the ApprovalRouter approval queue. No replacement comment or CLAUDE.md note documents this trade-off.

Suspected tasks: TASK-785
- **suggested_action:** Add a comment at the settingSources site documenting the intentional trade-off: user settings are now loaded (for MCP servers, custom instructions, etc.) with the acknowledged risk that user-level tool allow-lists may bypass the PreToolUse hook. If ApprovalRouter bypass is unacceptable, investigate whether the SDK supports loading user settings selectively (e.g. MCP config only, not permission rules).
- **resolved_by:** 
