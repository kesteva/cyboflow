---
sprints: [SPRINT-038]
span_label: SPRINT-038
created: 2026-05-26T00:00:00.000Z
counters_start:
  ideas: 24
summary:
  cleanups: 3
  backlog_tasks: 4
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-038

## A. Clean-up items (execute now)

### A1. Remove local `CreateSessionRequest` re-declaration in sessionStore.ts
- **Summary:** `frontend/src/stores/sessionStore.ts` has its own 3-field local `interface CreateSessionRequest` that duplicates (partially) the canonical type in `frontend/src/types/session.ts`, making the TASK-753 sync-warning comment visibly incomplete.
- **Source-Sprint:** SPRINT-038
- **Rationale:** TASK-753 just installed in-sync comments on both canonical `CreateSessionRequest` declarations, but there is a third declaration — a Crystal-baseline 3-field stub at `frontend/src/stores/sessionStore.ts:5-9` — that is now visibly excluded from that safety net. Removing it costs nothing (it is a subset of the canonical type) and makes the sync comment load-bearing instead of misleading.
- **Blast radius:** `frontend/src/stores/sessionStore.ts` only; no production logic changes — parameter types for `sessionStore.createSession` stay compatible with `Pick<CreateSessionRequest, ...>`. Risk: trivial.
- **Source:** FIND-SPRINT-038-5 (surfaced by sprint-code-reviewer after TASK-753 added sync-warning comments)
- **Proposed change:**
  ```diff
  // frontend/src/stores/sessionStore.ts
  - // NOTE: this is a local partial copy — keep in sync with frontend/src/types/session.ts CreateSessionRequest
  - interface CreateSessionRequest {
  -   prompt: string;
  -   worktreeTemplate: string;
  -   count: number;
  - }
  + import type { CreateSessionRequest } from '../types/session';
  ```
  If `sessionStore.createSession` genuinely needs only a subset, use `Pick<CreateSessionRequest, 'prompt' | 'worktreeTemplate' | 'count'>` as the parameter type instead of importing the full interface — either way the local re-declaration disappears.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `frontend/src/stores/sessionStore.ts:5-9` declares a 3-field local `CreateSessionRequest` and the sole caller (`PromptHistoryModal.tsx:68-72`) passes exactly `{ prompt, worktreeTemplate, count }`, so `Pick<>` of the canonical type from `frontend/src/types/session.ts:126` is a drop-in replacement that makes the TASK-753 sync-warning comment load-bearing.

---

### A2. Guard Start Run button against concurrent quick-session in-flight
- **Summary:** The Start Run button in `WorkflowPicker.tsx` does not check `quickSession.isStarting`, allowing a race where a workflow run and a quick session launch simultaneously and clobber each other's store state.
- **Source-Sprint:** SPRINT-038
- **Rationale:** TASK-752 introduced `quickSession.isStarting` and used it to disable both quick-session buttons, but the Start Run button's `disabled` predicate was not extended. If a user clicks Quick Chat then immediately clicks Start Run before the first call resolves, both `setActiveRun` and `setActiveQuickSession` will fire — whichever resolves last wins, leaving an orphan panel and worktree. The fix is one line.
- **Blast radius:** `frontend/src/components/cyboflow/WorkflowPicker.tsx` (1-line production change) + `frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx` (1 new assertion). Risk: low.
- **Source:** FIND-SPRINT-038-7 (surfaced by sprint-code-reviewer; attributed to TASK-752 which introduced `quickSession.isStarting` without extending the Start Run guard)
- **Proposed change:**
  ```diff
  // frontend/src/components/cyboflow/WorkflowPicker.tsx
  - disabled={selectedId === null || isLoading || isStarting}
  + disabled={selectedId === null || isLoading || isStarting || quickSession.isStarting !== null}
  ```
  Also add a regression test in `WorkflowPicker.test.tsx` asserting that the Start Run button is `disabled` while `quickSession.isStarting` is non-null.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `frontend/src/components/cyboflow/WorkflowPicker.tsx:110` confirms `disabled={selectedId === null || isLoading || isStarting}` lacks the `quickSession.isStarting` check that lines 121 and 129 (quick buttons) have, leaving a real race window where concurrent `setActiveRun` + `setActiveQuickSession` violate `cyboflowStore`'s mutual-exclusion invariant — and the fix is genuinely one line.

---

### A3. Standardise mock pattern in WorkflowPicker tests to use API wrapper
- **Summary:** `WorkflowPicker.test.tsx` still patches `window.electronAPI.sessions.createQuick` via `Object.defineProperty`, while the two sibling test files created in TASK-752 mock `../../../utils/api` — inconsistency will cause confusing diagnostic divergence in future API-wrapper refactors.
- **Source-Sprint:** SPRINT-038
- **Rationale:** Both approaches work today because `API.sessions.createQuick` is a thin pass-through to `window.electronAPI.sessions.createQuick`. But if any pre-flight validation or error normalisation is ever added to the API wrapper, `WorkflowPicker.test.tsx` will silently bypass it while the other two tests catch the regression, producing misleading test results. The fix is a pure test-only refactor with no production-code changes.
- **Blast radius:** `frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx` only; no production code touched. Risk: trivial.
- **Source:** FIND-SPRINT-038-8 (surfaced by sprint-code-reviewer; TASK-752 created the two newer test files with the correct pattern but left the existing WorkflowPicker test on the old one)
- **Proposed change:**
  Replace the `Object.defineProperty(window, 'electronAPI', …)` block in `WorkflowPicker.test.tsx:100-135` with:
  ```diff
  - Object.defineProperty(window, 'electronAPI', {
  -   value: { sessions: { createQuick: mockCreateQuick } },
  -   writable: true,
  - });
  + vi.mock('../../../utils/api', () => ({
  +   API: { sessions: { createQuick: vi.fn() } },
  + }));
  ```
  Update the internal `mockCreateQuick` references to read from the mocked module (`(API.sessions.createQuick as ReturnType<typeof vi.fn>)`). No production-code change required.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `WorkflowPicker.test.tsx:128-135` uses `Object.defineProperty(window, 'electronAPI', …)` while the two sibling tests (`CyboflowRoot.test.tsx:76-86`, `useQuickSession.test.tsx:32-38`) `vi.mock('../../utils/api', …)` — pure test-only refactor of one file aligns the trio and clears the cleanup bar for near-zero cost.
- **Counterfactual:** If the refactor required touching more than the one test file or threading new fixture state through other tests, the proportionality calculus flips.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Write `run_id` on session creation so the Quick badge renders correctly
- **Summary:** Every session row is created with `run_id = NULL` because the `createSession` INSERT omits the column — so the TASK-751 mapper fix is correct but the Quick badge displays universally regardless of session type.
- **Source-Sprint:** SPRINT-038
- **Source:** FIND-SPRINT-038-4 (surfaced by sprint-code-reviewer; attributed to TASK-751 mapper being correct but incomplete — migration 009 adds the column but no write path exists)
- **Problem:** `main/src/database/database.ts:2057` omits `run_id` from the `createSession` INSERT column list (acknowledged in `main/src/ipc/session.ts:312-313`). No `UPDATE sessions SET run_id` statement exists anywhere in the main process. Net effect: `dbSession.run_id` is always `NULL`, `session.runId` is always `null`, and `session.runId == null` (the Quick-badge predicate in `SessionListItem.tsx:431`) is therefore always true — every session displays the Quick badge. The regression test in `sessionManagerRunIdMapping.test.ts` proves the three-case mapper round-trip works, but does not exercise an actual DB INSERT, so it could not catch this gap. This leaves the user-visible part of FIND-SPRINT-037-1 entirely unfixed.
- **Proposed direction:** Three sequential changes: (1) add `run_id` to the `createSession` INSERT column list in `database.ts:2057` and expose it through `CreateSessionData` in `main/src/types/session.ts`; (2) identify where the flow runtime materialises a flow-owned session (likely `runExecutor` or the workflow-runs orchestrator) and thread the active `runId` through into the `createSession` call; (3) extend `sessionManagerRunIdMapping.test.ts` with a fixtures-DB round-trip test that INSERTs with `run_id='flow-001'` and asserts `session.runId === 'flow-001'` on the read-back. Quick sessions created via `createQuick` should continue to produce `run_id = NULL` (they are not flow-owned). The task plan should audit whether `CreateSessionData` already has a `runId` field or if it needs to be added, and should confirm migration 009 (`009_sessions_run_id.sql`) already covers the schema side before touching the INSERT.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Bug is real and user-visible — `main/src/database/database.ts:2058` INSERT omits `run_id`, the only callers of `db.createSession` are `sessions:create` and `sessions:create-quick` (neither of which writes a runId), and `runExecutor.ts:189-190` uses `panelId = sessionId = runId` as a *logical* invariant without inserting into the sessions table, so `runId == null` (predicate at `SessionListItem.tsx:431`) is true for every session row and the Quick badge displays universally.
- **Counterfactual:** The proposed direction's step (2) ("thread runId from runExecutor or the workflow-runs orchestrator") is based on a wrong premise — the executor never INSERTs sessions, so a planner must rework the approach (e.g. add a write path on workflow-run creation, or change the badge predicate to a different signal). IMPLEMENT stands because refinement is the appropriate next step for a real medium-severity bug; the planner is expected to correct the direction.

---

### B2. Audit and resolve pre-existing `isMainRepo` / `model` parity gaps in `CreateSessionRequest`
- **Summary:** `CreateSessionRequest` has two pre-existing field divergences between its main and frontend declarations — `isMainRepo` (frontend-only) and `model` (main-only) — each a silent-drop risk matching the FIND-SPRINT-024-4 pattern.
- **Source-Sprint:** SPRINT-038
- **Source:** FIND-SPRINT-038-3 (surfaced by code-reviewer after TASK-753 closed the `branchName`/`quickSession` gap; both fields predate SPRINT-038)
- **Problem:** In `main/src/types/session.ts:59-78` vs `frontend/src/types/session.ts:126-145`, two fields differ: (1) `isMainRepo?: boolean` is declared only on the frontend side — if the frontend sends it, the main handler never reads a typed value; (2) `model?: string` is declared only on the main side — however, the request also carries `claudeConfig.model` (declared on both sides), so a top-level `model` may be dead or may shadow the nested one. Each field is a live risk: a field the sender declares but the receiver omits (or vice versa) silently falls back to `undefined` with no TypeScript error.
- **Proposed direction:** Grep `main/src/ipc/session.ts` (and any other `CreateSessionRequest` consumer, e.g. `main/src/services/sessionManager.ts`) for `request.model` and `request.isMainRepo`. For each field: (a) if read server-side but absent from the frontend declaration, add it to `frontend/src/types/session.ts`; (b) if present on the frontend but never read server-side, delete it from `frontend/src/types/session.ts`; (c) if neither side reads nor sends it, delete from both. Pay special attention to `model` vs `claudeConfig.model` — document which one the handler actually uses. As a coda, evaluate whether this task is the right moment to promote `CreateSessionRequest` to `shared/types/ipc.ts` per the sync-warning comment TASK-753 added; if the field count is small and the handler audit is clean, a single-shared-type promotion is in scope.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Audited both fields — `grep -rn "request\.model\|request\.isMainRepo" main/src` returns zero matches in production code (the only `isMainRepo` reads in `sessionManager.ts` are positional params, and `ipc/session.ts:225-258` never reads `request.model`), so both fields are dead on both sides and B2 is straight delete-both — proportional and tracks the CLAUDE.md "IPC request-shape parity" rule.

---

### B3. Fix stale closure on `isStarting` guard in `useQuickSession`
- **Summary:** The `useCallback` in `useQuickSession.ts` captures `isStarting` from the first render (via missing deps), making the in-hook re-entry guard dead code that silently fails if a future caller omits the UI-level disabled check.
- **Source-Sprint:** SPRINT-038
- **Source:** FIND-SPRINT-038-2 (surfaced by code-reviewer of TASK-752; zero practical impact today because both consumers gate via `disabled` props, but the eslint-disable comment's justification is factually incorrect)
- **Problem:** `useQuickSession.ts:39-84` has `useCallback` with deps `[opts.projectId, opts.onSuccess]`, deliberately excluding `isStarting` behind an `eslint-disable-next-line react-hooks/exhaustive-deps`. The justification comment reads "setIsStarting is synchronous within the render cycle" — this is incorrect. `setState` schedules a re-render asynchronously; the memoized callback's closure therefore captures the `isStarting` value from the render in which the callback was first created, and the guard `if (… || isStarting !== null) return;` cannot fire on a second rapid invocation that occurs between the first call's `setIsStarting('claude')` and the subsequent re-render. Today this has zero practical impact because `WorkflowPicker.tsx:121,129` disables both buttons when `isStarting !== null`, and `CyboflowRoot.tsx:116,123` dismisses the picker before `start` runs — both consumers handle re-entry at the UI layer. But the in-hook guard is effectively dead, and if a future caller forgets the UI gate the hook will silently double-create sessions.
- **Proposed direction:** Two implementation options — the task plan should pick one and justify: (a) move `isStarting` to a `useRef<'claude' | 'none' | null>` for the guard logic, keep a separate `useState` only for the rendered return value; the ref is always current inside the closure so the guard fires correctly and the eslint-disable disappears; (b) add `isStarting` to the deps array and remove the `eslint-disable` plus the incorrect comment — the callback recreates on every state transition, but since it's only called from user interaction this is not a perf concern. Either way update the comment to accurately describe what the chosen approach does, and add a test to `useQuickSession.test.tsx` that calls `start` twice in the same render cycle (before the re-render from the first call) and asserts only one `createQuick` IPC call is made.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The finding explicitly acknowledges "zero practical impact today because both consumers gate via UI-level disabled (`WorkflowPicker.tsx:121,129`) or unmount the buttons immediately on click (`CyboflowRoot.tsx:116,123`)" — this is preemptive defense for a future caller who *might* forget the UI gate, exactly the speculative pattern the skeptic protocol rejects, and the misleading-comment wart is a 1-line fix that does not justify a backlog task with two implementation options.
- **Counterfactual:** If a third consumer of `useQuickSession` lands without a UI-level disabled gate, the in-hook guard becomes load-bearing and this flips to IMPLEMENT.

---

### B4. Resolve ambiguous `onWorkflowStarted` prop name in `WorkflowPickerProps`
- **Summary:** `WorkflowPickerProps.onWorkflowStarted(runId: string)` is called with a `sessionId` on the quick-session path and a `runId` on the workflow path — the parameter name is factually wrong for half the callers, making it a type-safety trap for the next consumer.
- **Source-Sprint:** SPRINT-038
- **Source:** FIND-SPRINT-038-6 (surfaced by sprint-code-reviewer; attributed to TASK-752 which wired `useQuickSession({ onSuccess: onWorkflowStarted })` where `onSuccess` is called with a sessionId)
- **Problem:** `WorkflowPickerProps.onWorkflowStarted: (runId: string) => void` (`WorkflowPicker.tsx:22`) is invoked from two paths: (a) `onWorkflowStarted?.(result.runId)` at line 71 (workflow run — correct: a runId); (b) `useQuickSession({ onSuccess: onWorkflowStarted })` at line 32 (quick session — `onSuccess` is called with a sessionId, not a runId). The current sole consumer `CyboflowRoot.tsx:189` ignores the argument entirely, so there is no live bug, but the signature is a trap: any future consumer that reads `(runId: string)` and tries to call `setActiveRun(id)` will pass a sessionId and silently subscribe the wrong stream.
- **Proposed direction:** Two options — the plan should choose: (a) rename the prop to `onStarted` and the parameter to `id`, add a JSDoc comment `// sessionId for quick sessions, runId for workflow runs`; or (b) split into two props `onRunStarted: (runId: string) => void` and `onQuickSessionStarted: (sessionId: string) => void`, routing them separately through `useQuickSession({ onSuccess: onQuickSessionStarted })` and the workflow-run success callback. Option (b) is the safer long-term choice because callers cannot conflate the two ID spaces. Update `CyboflowRoot.tsx` to pass the correct prop(s), and update tests accordingly.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `CyboflowRoot.tsx:189` (the sole consumer) is `onWorkflowStarted={() => setIsPickerOpen(false)}` — it ignores the argument entirely, so the finding's "no live bug" admission stands, and Option (b)'s split-into-two-props adds a permanent abstraction for a hypothetical second consumer that does not exist; if cleanup is desired, Option (a)'s 1-line rename belongs in a future Bucket A, not a backlog task.
- **Counterfactual:** If a second non-trivial consumer of `WorkflowPicker` appears (e.g. a header-mount that calls `setActiveRun(id)` directly), this flips to IMPLEMENT with Option (b).

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add Electron renderer pre-flight check to visual verification setup doc
- **Summary:** `docs/VISUAL-VERIFICATION-SETUP.md` documents Peekaboo permissions but does not say how to confirm the Electron renderer window is actually open before a visual verification attempt — `pnpm dev` parent processes can be alive while no Electron window exists.
- **Source-Sprint:** SPRINT-038
- **Target file:** `docs/VISUAL-VERIFICATION-SETUP.md`
- **Action:** insert-after `"and relaunch the host process."` (end of "macOS Permissions Required for Peekaboo" subsection, line 50)
- **Status:** ready
- **source_item:** C1
- **Rationale:** TASK-752 verifier attempted `visual_macos` verification and found `concurrently` + `electron-dev` parent processes alive in `ps` but no Electron renderer window. Existing doc covers Peekaboo permissions but has no step telling the operator to verify a capturable window exists. Refined to use `lsof -i :9223` (the genuine renderer liveness signal — CDP port) instead of `pgrep -lf "electron ."` (which matches `concurrently`'s argv even when the renderer is dead). (FIND-SPRINT-038-1)
- **Diff:**
  ```diff
  @@ docs/VISUAL-VERIFICATION-SETUP.md
   Screen Recording alone is NOT sufficient: capture works but interaction is
   silently blocked. If `visual_macos` returns screenshots but clicks/keystrokes
   do nothing, check Accessibility first. After granting either permission, quit
   and relaunch the host process.

  +### Pre-flight: confirm the Electron renderer is actually running
  +
  +`pnpm dev`'s `concurrently` + `wait-on` parents can survive in `ps` after the
  +Electron renderer has exited — `pgrep -lf "electron"` then matches the
  +`concurrently` command line and falsely suggests a live window. A capture
  +attempt against a windowless run fails with `-3811` audio/video errors or
  +returns 0 windows.
  +
  +Before any `mcp__peekaboo__image` call, confirm the renderer is up:
  +
  +1. CDP port is listening (only true when the Electron renderer is alive):
  +   ```bash
  +   lsof -i :9223     # must show an `electron` LISTEN entry
  +   ```
  +2. Peekaboo sees a Cyboflow window:
  +   ```
  +   mcp__peekaboo__list(application_windows, app="Electron")
  +   # or app="Cyboflow" — window count must be ≥ 1
  +   ```
  +
  +If either check fails, restart `pnpm dev` and wait for the renderer to load
  +before retrying. (FIND-SPRINT-038-1; reproduces SPRINT-029/031 verifier patterns.)
  +
   ### Troubleshooting: "audio/video capture failure" despite grants showing clean
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `docs/VISUAL-VERIFICATION-SETUP.md` already documents the Peekaboo path (lines 30-60) and is referenced from CLAUDE.md ("Visual verification"), but lacks a concrete liveness probe — the proposed `lsof -i :9223` check is the genuine CDP-port signal (line 13 confirms Electron is launched with `--remote-debugging-port=9223`) which is strictly better than `pgrep` for distinguishing a live renderer from a surviving `concurrently` parent, and the insert is doc-only with near-zero cost.

---

## Reconciled Findings (informational)

No stale-open findings were found. None of the done reports (`TASK-751`, `TASK-752`, `TASK-753`) claimed resolution of any FIND-SPRINT-038-* finding — all eight findings were genuinely open at compound time and have been triaged above or excluded by bucket rules.
