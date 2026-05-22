---
sprint: SPRINT-030
pending_count: 1
last_updated: "2026-05-21T17:10:00.000Z"
---
# Findings Queue

## FIND-SPRINT-030-1
- **type:** bug
- **source:** TASK-698 (executor)
- **severity:** medium
- **status:** resolved
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
- **description:** The killProcess test times out at 5000ms on both main and TASK-698 worktree. Pre-existing flaky test unrelated to TASK-698.
- **suggested_action:** Investigate mock/async setup - likely a promise or observable that never resolves. Fix the underlying mock or increase timeout.
- **resolved_by:** verifier — status-sync: TASK-697 (commit f0063a7 removed the pre-kill await on spawnPromise, eliminating the deadlock; killProcess test now passes in ~7ms across 3 consecutive full-suite runs)

## FIND-SPRINT-030-2
- **type:** improvement
- **source:** TASK-696 (code-reviewer)
- **severity:** low
- **status:** open
- **location:** frontend/src/utils/cyboflowApi.ts:52-58 (StreamEventType union); frontend/src/components/cyboflow/RunView.tsx:39-45 (local widening)
- **description:** TASK-696 added `session_info` and `rate_limit_event` to the renderer's `switch (event.type)` dispatcher. Because `cyboflowApi.ts` is marked `files_readonly` for the task, the renderer falls back to a local `ExtendedStreamEventType` alias and an inline `event.type as ExtendedStreamEventType` cast at the switch site. The inline `// TODO(IDEA-021 follow-up): widen StreamEventType in cyboflowApi.ts in a sibling task` comment captures the intent but the widening still needs a backlog task to land. Until then, any future RunView contributor adding another typed branch will have to extend the local alias (or perpetuate the cast) instead of relying on the canonical `StreamEventType` union — which is exactly the drift surface this comment warns about.
- **suggested_action:** Open a follow-up task to widen `StreamEventType` in `frontend/src/utils/cyboflowApi.ts` to include `'session_info' | 'rate_limit_event'` (and audit `main/src/services/streamParser/derivers.ts:deriveEventType` to confirm both strings are actually emitted on the envelope `type` field). On landing, remove the `ExtendedStreamEventType` alias + cast in `RunView.tsx` and the two `as StreamEvent['type']` casts in `RunView.test.tsx:396, :424`.
- **resolved_by:**
