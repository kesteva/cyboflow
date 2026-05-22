---
sprint: SPRINT-032
pending_count: 1
last_updated: "2026-05-22T00:00:00Z"
---

# Findings Queue

## FIND-SPRINT-032-1
- **source:** TASK-693 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useEnsureClaudePanel.ts:73
- **description:** The `useCallback` deps are `[session?.id, addPanel, setActivePanelInStore, logTag]` with a trailing `// eslint-disable-line react-hooks/exhaustive-deps`. The sibling `useAddTerminalPanel.ts:53` uses `[session, addPanel, setActivePanelInStore, onAfterActivate, logTag]` (whole session object, no eslint-disable) and passes lint cleanly. Functionally both are correct because the callback only reads `session.id` and Zustand actions are stable references, but the disable here is gratuitous — it diverges from the sibling-hook precedent the rest of this file mirrors and tells the linter to stop checking a rule that would actually pass if the deps were written as `[session, ...]`.
- **suggested_action:** Change deps to `[session, addPanel, setActivePanelInStore, logTag]` and drop the eslint-disable comment, matching `useAddTerminalPanel.ts`.
- **resolved_by:**
