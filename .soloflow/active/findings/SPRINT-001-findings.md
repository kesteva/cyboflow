---
sprint: SPRINT-001
pending_count: 2
last_updated: "2026-05-11T21:30:00Z"
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
