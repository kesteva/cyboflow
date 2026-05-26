---
sprint: SPRINT-038
pending_count: 8
last_updated: "2026-05-26T04:47:53.233Z"
---
# Findings Queue

## FIND-SPRINT-038-1
- **type:** claude-md
- **severity:** low
- **source:** TASK-752 (verifier)
- **status:** open
- **description:** Peekaboo MCP visual_macos verification could not run: pnpm dev parent processes (concurrently + electron-dev) were alive but no Electron renderer window was present (no Electron/Cyboflow process in `ps`, no window in Peekaboo `list`). docs/VISUAL-VERIFICATION-SETUP.md describes Peekaboo+permissions but does not document the operator-level check that the Electron window is actually open before a verifier spawn. Consider adding a pre-flight note: `if visual_macos=true, confirm an Electron renderer process is running (e.g. `pgrep -lf "electron ."`) — concurrently parent alone is not sufficient`.
- **suggested_action:** Add an operator-check note to docs/VISUAL-VERIFICATION-SETUP.md describing how to confirm the Electron renderer window is open before running the verifier.
- **resolved_by:** 

## FIND-SPRINT-038-2
- **source:** TASK-752 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useQuickSession.ts:39-84
- **description:** The `useCallback` deps array `[opts.projectId, opts.onSuccess]` deliberately excludes `isStarting` with an `eslint-disable-next-line react-hooks/exhaustive-deps`. The justification comment ("setIsStarting is synchronous within the render cycle") is incorrect — `setState` schedules a re-render asynchronously, so the memoized callback's closure captures whatever `isStarting` was at first render and the in-hook guard `if (… || isStarting !== null) return;` cannot fire on a second invocation that happens between the first invocation's `setIsStarting('claude')` and the next render. Today this has zero practical impact because both consumers gate via UI-level `disabled` (`WorkflowPicker.tsx:121,129`) or unmount the buttons immediately on click (`CyboflowRoot.tsx:116,123` dismiss the picker before `start` runs). But the in-hook re-entry guard is effectively dead code, and if a future caller forgets the UI guard the hook will silently double-create sessions. Either (a) move the in-flight flag to a `useRef` so the closure sees current values, or (b) add `isStarting` to the deps and drop the `eslint-disable` — both make the in-hook guard real and let the misleading comment go away.
- **suggested_action:** Replace the `useState`-based `isStarting` flag inside the closure check with a `useRef<'claude' | 'none' | null>` (keeping the `useState` only for the React-rendered return value), OR add `isStarting` to the deps array and remove the `eslint-disable` + the incorrect justification comment.
- **resolved_by:** 

## FIND-SPRINT-038-3
- **source:** TASK-753 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/types/session.ts:59-78 vs frontend/src/types/session.ts:126-145
- **description:** TASK-753 closed the `quickSession` / `branchName` parity gap from FIND-SPRINT-037-5, but a `diff` of the two `CreateSessionRequest` declarations still surfaces two pre-existing field-set divergences of the same class: (1) `isMainRepo?: boolean` is declared only on the frontend side and (2) `model?: string` is declared only on the main side. Both predate TASK-753 and were out of scope for the plan, but each is exactly the silent-drop pattern documented in CLAUDE.md's "IPC request-shape parity" rule — a field one side reads or sends that the twin does not declare. `model` on `CreateSessionRequest` is especially suspect because the request also carries a nested `claudeConfig.model` (declared on both sides), so a top-level `model` set only on the main type may be either dead or shadow the nested one; needs an ipc/session.ts handler audit to classify. `isMainRepo` on the frontend declaration may be dead, or may be a real send-side field the main handler ignores.
- **suggested_action:** Grep `main/src/ipc/session.ts` (and any other CreateSessionRequest consumer) for `request.model` and `request.isMainRepo` reads. For each field: if read on the server but missing from the frontend declaration (or vice-versa), add it to the twin; if neither side reads it, delete it. Resolve both gaps in a single follow-up task and consider whether the next IPC touch should finally promote `CreateSessionRequest` to `shared/types/ipc.ts` per the sync-warning comment.
- **resolved_by:** 

## FIND-SPRINT-038-4
- **source:** SPRINT-038 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/services/sessionManager.ts:221 + main/src/database/database.ts:2057-2077 + main/src/database/migrations/009_sessions_run_id.sql
- **description:** FIND-SPRINT-037-1 (Quick-badge inversion) is mapper-correct but observably unfixed. TASK-751 added `runId: dbSession.run_id ?? null` to convertDbSessionToSession and a regression test proves the three-case round trip works. However: (a) migration 009 adds sessions.run_id as nullable with no default-non-NULL write path; (b) `createSession` in database.ts:2057 omits `run_id` from its INSERT column list (acknowledged in main/src/ipc/session.ts:312-313); (c) no UPDATE sessions SET run_id statement exists anywhere in main/src. Net effect: every session row is created with run_id = NULL, so `session.runId == null` (SessionListItem.tsx:431) is true for every session and the Quick badge still displays universally — the same user-visible outcome as the original bug. The TASK-751 done-note phrasing `the read-only UI consumer is now driven by correct data` is misleading; the mapper is correct but its data source is uniformly NULL.
- **suggested_action:** Backlog a follow-up task to write run_id on flow-owned session creation. Concretely: (1) add run_id to the createSession INSERT column list in database.ts:2057 and surface it through CreateSessionData (main/src/types/session.ts); (2) thread the active runId from the flow runtime (likely runExecutor or the workflow-runs orchestrator) into the createSession call that materializes a flow-owned session; (3) extend the existing sessionManagerRunIdMapping test with a fixtures-DB round trip that proves an INSERT with run_id="flow-001" yields session.runId="flow-001". Until this lands the Quick badge is universally on; the mapper alone closes none of the user-visible part of FIND-SPRINT-037-1.
- **resolved_by:** 





Suspected tasks: TASK-751 (mapper only); upstream gap left by TASK-743 (migration deferred backfill)

## FIND-SPRINT-038-5
- **source:** SPRINT-038 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/stores/sessionStore.ts:5-9
- **description:** TASK-753 added `// NOTE: keep this interface in sync with main/src/types/session.ts CreateSessionRequest` to both the main and frontend canonical declarations, but missed a third — `frontend/src/stores/sessionStore.ts:5-9` declares its own local `interface CreateSessionRequest { prompt; worktreeTemplate; count }` that is a *structurally different* partial shape (3 of the 16 fields) used only by `sessionStore.createSession`. This is exactly the dual-declaration drift CLAUDE.md warns about, just one layer deeper. It is Crystal-baseline legacy, pre-existing the sprint, but the comment TASK-753 just installed now visibly excludes it.
- **suggested_action:** In a follow-up: replace the local `interface CreateSessionRequest` in `frontend/src/stores/sessionStore.ts` with `import type { CreateSessionRequest } from `../types/session`` (or, if `sessionStore.createSession` truly needs only a subset, type its parameter as `Pick<CreateSessionRequest, `prompt` | `worktreeTemplate` | `count`>`). Either way the local re-declaration disappears and the new TASK-753 sync comment becomes load-bearing.
- **resolved_by:** 




Suspected tasks: TASK-753 (added the in-sync comment that highlighted this third declaration)

## FIND-SPRINT-038-6
- **source:** SPRINT-038 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/WorkflowPicker.tsx:22 + 32 + 71
- **description:** `WorkflowPickerProps.onWorkflowStarted: (runId: string) => void` is now wired both to (a) the workflow-run success path (`onWorkflowStarted?.(result.runId)` at line 71) AND (b) the quick-session success path via `useQuickSession({ projectId, onSuccess: onWorkflowStarted })` at line 32, where `useQuickSession.onSuccess` is called with a *sessionId*, not a runId. After SPRINT-038 the prop name and the parameter name (`runId`) are factually wrong for half the call paths. The current sole consumer (`CyboflowRoot.tsx:189`) ignores the argument, so there is no live bug, but the next consumer who reads the signature and tries to call `setActiveRun(id)` with what they think is a runId will instead pass a sessionId and quietly subscribe the wrong stream.
- **suggested_action:** Either (a) rename the prop to `onStarted` and the parameter to `id` with a doc-comment that says "sessionId for quick sessions, runId for workflow runs"; or (b) split into two props `onRunStarted: (runId: string) => void` and `onQuickSessionStarted: (sessionId: string) => void` and route them separately. (b) is more honest and the safer fix because future callers cannot conflate them.
- **resolved_by:** 



Suspected tasks: TASK-752 (rewired WorkflowPicker quick logic through useQuickSession.onSuccess)

## FIND-SPRINT-038-7
- **source:** SPRINT-038 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/WorkflowPicker.tsx:110 vs 121,129
- **description:** The two quick-session buttons disable when either flow is in-flight (`quickSession.isStarting !== null || isStarting`), but the Start Run button only disables when a workflow-run is in-flight (`disabled={selectedId === null || isLoading || isStarting}`) — it does NOT check `quickSession.isStarting`. A user who clicks Quick Chat and then immediately clicks Start Run before the quick session resolves will kick off both flows simultaneously: a workflow run AND a quick session, both racing to call `setActiveRun` and `setActiveQuickSession` (which are mutually-exclusive in cyboflowStore). Whichever resolves last wins, and the loser leaves an orphan panel and worktree.
- **suggested_action:** Change the Start Run button to `disabled={selectedId === null || isLoading || isStarting || quickSession.isStarting !== null}`. Add a regression test in WorkflowPicker.test.tsx asserting that Start Run is disabled while quickSession.isStarting is non-null.
- **resolved_by:** 


Suspected tasks: TASK-752 (introduced `quickSession.isStarting` but did not extend the Start Run guard)

## FIND-SPRINT-038-8
- **source:** SPRINT-038 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx:100-135 vs frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx:77-86 + frontend/src/hooks/__tests__/useQuickSession.test.tsx:32-39
- **description:** After SPRINT-038, two of the three quick-session-touching test files have moved to mocking the typed wrapper (`vi.mock(`../../../utils/api`, () => ({ API: { sessions: { createQuick: vi.fn() }}}))`): `CyboflowRoot.test.tsx:77-86` and `useQuickSession.test.tsx:32-39`. The third — `WorkflowPicker.test.tsx:100-135` — still patches `window.electronAPI.sessions.createQuick` directly via `Object.defineProperty(window, `electronAPI`, …)`. Both work because `API.sessions.createQuick` is a thin pass-through to `window.electronAPI.sessions.createQuick` (`frontend/src/utils/api.ts:71-74`), but the inconsistency means a future refactor of the API wrapper (e.g. adding pre-flight validation) would break the WorkflowPicker tests in a different way than the other two and produce confusing diagnostics. Sprint-level visibility: TASK-752 created two tests using the new pattern and left the existing WorkflowPicker test on the old one.

Suspected tasks: TASK-752 (introduced the new mocking pattern in two of the three sibling tests)
- **suggested_action:** In a small test-only follow-up, refactor `WorkflowPicker.test.tsx:100-135` to mock `../../../utils/api` the same way as the two sibling tests; remove the `Object.defineProperty(window, `electronAPI`, …)` block; rename `mockCreateQuick` to read from the mocked module. No production-code change required.
- **resolved_by:** 
