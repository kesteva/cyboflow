---
sprint: SPRINT-037
pending_count: 7
last_updated: "2026-05-25T22:54:15.005Z"
---
# Findings Queue

SPRINT-037 started with missing infra: docker; tests deferred.

## FIND-SPRINT-037-1
- **source:** TASK-749 (code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main/src/services/sessionManager.ts:185-221 (convertDbSessionToSession)
- **description:** TASK-749 added `runId?: string | null` to both the frontend and main `Session` interfaces and gated the new `(Quick)` badge in `SessionListItem.tsx` on `session.runId == null`. However, the DB→frontend mapper `convertDbSessionToSession` in `main/src/services/sessionManager.ts` does not copy `run_id` from the DB row onto the returned `Session`. Every session arriving via `sessions:get-all-with-projects` (the path that feeds the sidebar) therefore has `runId === undefined` at runtime, regardless of the DB column's value. Because the badge predicate uses loose equality (`runId == null`), the Quick badge will render on **every** session — including flow-owned ones — silently inverting the intended behavior. The DbSession type (`main/src/database/models.ts:40`) also still omits `run_id`, so the mapper has no typed signal to wire through. This is the same silent-drop pattern as FIND-SPRINT-024-4 / FIND-SPRINT-033-6 documented in CLAUDE.md ("IPC handler ↔ declared T parity"). The five new SessionListItem tests pass because they construct sessions via the fixture directly (bypassing the mapper) — the regression is invisible to unit tests.
- **suggested_action:** Add `run_id?: string | null` to `DbSession` in `main/src/database/models.ts`, then add `runId: dbSession.run_id ?? null,` to `convertDbSessionToSession` in `main/src/services/sessionManager.ts`. Verify with a manual `pnpm dev` smoke pass (which TASK-749's step 10 already called out but did not catch). Consider a regression test that round-trips a quick session and a flow-owned session through `getSessionsForProject` and asserts on `session.runId`.
- **resolved_by:** 

## FIND-SPRINT-037-2
- **source:** TASK-750 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** .soloflow/active/plans/trpc-cutover-and-legacy-tree-cleanup/EPIC-trpc-cutover-and-legacy-tree-cleanup.md:12
- **description:** Active epic plan still describes the renderer as importing the typed tRPC client "via `frontend/src/utils/trpcClient.ts`". TASK-750 deleted that shim and migrated all 8 production callers + 1 test value-import to the canonical `frontend/src/trpc/client.ts`. The epic Context paragraph now references a path that no longer exists. Out-of-diff for TASK-750 (the epic doc is not in `files_owned`), so reporting via the queue rather than blocking the review.
- **suggested_action:** Edit the Context paragraph to reference `frontend/src/trpc/client.ts` instead of `frontend/src/utils/trpcClient.ts`. Single-line string replacement; no other content in the epic needs adjustment.
- **resolved_by:** 

## FIND-SPRINT-037-3
- **source:** SPRINT-037 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** frontend/src/components/cyboflow/CyboflowRoot.tsx:51-63
- **description:** Quick Session button from CyboflowRoot header creates orphan sessions — divergence from WorkflowPicker pattern. handlePickQuickMode calls createQuick but never bootstraps a panel, never calls setActiveQuickSession, and never navigates. In contrast, WorkflowPicker.handleQuickStart (TASK-747) does all three: panelApi.createPanel({ sessionId, type: claude|terminal }), useCyboflowStore.getState().setActiveQuickSession(sessionId), and onWorkflowStarted?.(sessionId). The result: clicking the header Quick Session button silently creates a worktree+session in the DB with no panel and no UI navigation. The user sees no feedback beyond the picker dismissing. CyboflowRoot tests assert createQuick is invoked but do NOT assert activeQuickSessionId is set, so unit tests pass while production is broken. This is the exact cross-task pattern divergence that per-task review could not see — TASK-747 and TASK-748 each implemented half the contract independently.
- **suggested_action:** Either (a) extract a shared useQuickSession hook (or createQuickSession helper) that encapsulates the full lifecycle — createQuick → panelApi.createPanel → setActiveQuickSession → optional callback — and call it from both WorkflowPicker.handleQuickStart and CyboflowRoot.handlePickQuickMode, or (b) inline the same three-step sequence into CyboflowRoot.handlePickQuickMode to match WorkflowPicker. Option (a) is preferred to prevent future drift. Also add a CyboflowRoot test that asserts panelApi.createPanel is called and activeQuickSessionId is set after picker selection.
- **resolved_by:** 





Suspected tasks: TASK-747, TASK-748

## FIND-SPRINT-037-4
- **source:** SPRINT-037 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/cyboflow/WorkflowPicker.tsx:77-104 + frontend/src/components/cyboflow/CyboflowRoot.tsx:51-63
- **description:** Two parallel handlers call sessions.createQuick with the same { prompt: "", projectId, toolType } payload shape — handleQuickStart in WorkflowPicker (TASK-747) and handlePickQuickMode in CyboflowRoot (TASK-748). Both directly access window.electronAPI.sessions.createQuick(...), bypassing the API.sessions.createQuick wrapper added in TASK-746 (frontend/src/utils/api.ts:71). Three issues stack here:
- **suggested_action:** Either route both handlers through API.sessions.createQuick (so the wrapper is exercised and isElectron() guard runs), or delete the wrapper if direct window.electronAPI access is the agreed pattern (then fix CLAUDE.md / api.ts JSDoc to document the policy). Combine with FIND-SPRINT-037-3 fix by extracting a useQuickSession hook that both call sites consume.
- **resolved_by:** 




1. The TASK-746 API wrapper is dead code — added but never consumed.
2. Both call sites duplicate the same shape literal { prompt: "", projectId, toolType }.
3. The two handlers diverge in post-create behavior (see FIND-SPRINT-037-3), suggesting the lack of a shared abstraction is what allowed the divergence to land.

Suspected tasks: TASK-746, TASK-747, TASK-748

## FIND-SPRINT-037-5
- **source:** SPRINT-037 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/types/session.ts:75 + frontend/src/types/session.ts:124-142
- **description:** Type-surface divergence between main and frontend CreateSessionRequest. TASK-744 added two fields to main/src/types/session.ts:
- **suggested_action:** Pick one: (a) Promote CreateSessionRequest to shared/types/ and import from both sides (preferred — aligns with the CLAUDE.md IPC parity guidance and the planned shared/types/ipc.ts location). (b) If quickSession is truly unused, delete it from main/src/types/session.ts. Add branchName to frontend/src/types/session.ts so callers can set it if needed.
- **resolved_by:** 



  quickSession?: boolean;
  branchName?: string;

Neither field exists in frontend/src/types/session.ts (the frontend CreateSessionRequest is missing both). Additionally:

- `quickSession?: boolean` is declared but never read anywhere in the codebase — `grep -rn quickSession --include=*.ts main/src frontend/src` returns 0 production reads. It is dead from inception.
- `branchName?: string` IS used by main/src/ipc/session.ts:338 but cannot be sent from the frontend because the frontend type does not include it. This works today because both callers (WorkflowPicker, CyboflowRoot) omit branchName and rely on the server default, but future frontend code that tries to set branchName would fail TypeScript checks.

The two CreateSessionRequest interfaces should be a single shared declaration (per the CLAUDE.md IPC handler ↔ declared T parity rule extended to request shapes). Otherwise this is the FIND-SPRINT-024-4 silent-drop pattern in mirror form.

Suspected tasks: TASK-744

## FIND-SPRINT-037-6
- **source:** SPRINT-037 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/database/database.ts:2138-2148
- **description:** DatabaseService.getQuickSessions(projectId?) was introduced by TASK-745 with thorough NULL-tolerance comments and two dedicated unit tests in cyboflowSchema.test.ts, but has zero production callers. The only references outside the implementation are the two test cases. The frontend currently fetches sessions exclusively through sessions:get-all-with-projects, which returns ALL sessions and lets the UI filter on session.runId == null (SessionListItem Quick badge). The getQuickSessions helper is a forward-looking method with no consumer.
- **suggested_action:** Decide: either thread getQuickSessions through to the UI in a follow-up task with a clear consumer, or remove it (and its two tests) to keep DatabaseService trim. If kept, add a @cyboflow-hidden marker and a TODO referencing the expected consumer task ID so future readers know it is intentional dead weight, not a missed wiring.
- **resolved_by:** 


This is not a bug — it is unused-but-tested infrastructure. Two of three reasonable outcomes:
(a) wire it into a future IPC channel (e.g. sessions:get-quick) and a frontend slice that needs a quick-sessions-only view (e.g. a Quick Sessions section in the sidebar); (b) delete it until a real consumer appears (YAGNI).

Suspected tasks: TASK-745

## FIND-SPRINT-037-7
- **source:** SPRINT-037 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/cyboflowStore.ts:88-132
- **description:** cyboflowStore exposes setActiveQuickSession + clearActiveQuickSession (TASK-745), but only one production caller exists: WorkflowPicker.handleQuickStart calls setActiveQuickSession. clearActiveQuickSession has zero production callers — only tests reference it (cyboflowStore.test.ts and WorkflowPicker.test.tsx in beforeEach setup). The mutual-exclusion invariant is well-documented and tested, but there is no production code path that exits a quick session and returns to the empty state without also setting an activeRun. If/when a future task adds a Close Quick Session UI action, clearActiveQuickSession will be wired up; until then it is test-only API surface.

Suspected tasks: TASK-745
- **suggested_action:** Acceptable to leave as-is given the small public surface and clear naming, but consider documenting in the cyboflowStore JSDoc that clearActiveQuickSession has no current production caller and is preserved for the planned Close Quick Session UI action (which task?). Avoids future readers wondering why it exists.
- **resolved_by:** 
