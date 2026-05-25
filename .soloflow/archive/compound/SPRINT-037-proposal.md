---
sprints: [SPRINT-037]
span_label: SPRINT-037
created: 2026-05-25T00:00:00.000Z
counters_start:
  ideas: 24
summary:
  cleanups: 1
  backlog_tasks: 4
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-037

## A. Clean-up items (execute now)

### A1. Fix stale shim path in active epic context paragraph
- **Summary:** The tRPC-cutover epic plan still cites the deleted `frontend/src/utils/trpcClient.ts` shim; a one-line string replacement corrects it to the canonical `frontend/src/trpc/client.ts`.
- **Source-Sprint:** SPRINT-037
- **Rationale:** TASK-750 deleted the shim and migrated all 8 production callers, but its plan explicitly excluded the epic doc from `files_owned`. The stale reference will misdirect any agent that loads the epic for context and follows the path.
- **Blast radius:** Single file, single line. Trivial.
- **Source:** FIND-SPRINT-037-2 (TASK-750 code-reviewer); confirmed by TASK-750 done report ("Reviewer surfaced one out-of-diff finding: … queued for compound").
- **Proposed change:**
  ```diff
  --- a/.soloflow/active/plans/trpc-cutover-and-legacy-tree-cleanup/EPIC-trpc-cutover-and-legacy-tree-cleanup.md
  +++ b/.soloflow/active/plans/trpc-cutover-and-legacy-tree-cleanup/EPIC-trpc-cutover-and-legacy-tree-cleanup.md
  @@ -10,1 +10,1 @@
  -via `frontend/src/utils/trpcClient.ts`
  +via `frontend/src/trpc/client.ts`
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `frontend/src/utils/trpcClient.ts` does not exist on disk, `frontend/src/trpc/client.ts` does, and the active epic at line 12 still cites the deleted path — one-line edit to an active doc, near-zero blast radius, real misdirection risk for any agent that loads the epic for context.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Fix convertDbSessionToSession mapper — wire run_id so Quick badge is accurate
- **Summary:** The DB→frontend session mapper omits `run_id`, so every session arrives at the sidebar with `runId === undefined`, causing the new Quick badge to render on all sessions rather than only quick sessions.
- **Source-Sprint:** SPRINT-037
- **Source:** FIND-SPRINT-037-1 (TASK-749 code-reviewer); TASK-749 done report ("every session arriving via sessions:get-all-with-projects has runId === undefined at runtime … the regression is invisible to the unit suite").
- **Problem:** `main/src/services/sessionManager.ts:185-221` (`convertDbSessionToSession`) does not copy `run_id` from the DB row onto the returned `Session`. Additionally, the `DbSession` type in `main/src/database/models.ts` (the `Session` interface at line 40) omits `run_id`, so there is no typed signal for the mapper to wire through. Because `SessionListItem.tsx` uses loose equality (`session.runId == null`) for the Quick badge, the missing field evaluates as `undefined == null → true`, causing the badge to fire on every session — including flow-owned ones — silently inverting the intended behavior. The five new `SessionListItem` tests construct sessions directly from fixtures and bypass the mapper, so this regression is invisible to the current unit suite.
- **Proposed direction:** Two-step fix: (1) Add `run_id?: string | null` to the `Session` interface in `main/src/database/models.ts` (the type used as `DbSession` throughout `sessionManager.ts`). (2) In `convertDbSessionToSession` in `main/src/services/sessionManager.ts`, add `runId: dbSession.run_id ?? null` to the returned object. Optionally add a regression test in `main/src/services/__tests__/` that round-trips a quick-session row (with `run_id IS NULL`) and a flow-owned row (with a non-null `run_id`) through the mapper and asserts on `runId`. TASK-749's verification step 10 (manual `pnpm dev` smoke pass) already called for this but did not catch the gap; include the smoke as the final AC gate.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `main/src/services/sessionManager.ts:185-221` does not copy `run_id`, `main/src/database/models.ts:40-69` `Session` interface omits `run_id`, the column exists per migration 009 (`database.ts:2123`), and `SessionListItem.tsx:431` uses `session.runId == null` — silently inverts the Quick badge on every session; severe user-visible regression with a 2-line fix.

### B2. Complete CyboflowRoot quick-session lifecycle — panel creation + store wiring
- **Summary:** The Quick Session header button in `CyboflowRoot` creates a worktree and session in the DB but never bootstraps a panel, sets `activeQuickSessionId`, or navigates — leaving users with no visible feedback after clicking.
- **Source-Sprint:** SPRINT-037
- **Source:** FIND-SPRINT-037-3 (SPRINT-037 sprint-code-reviewer); TASK-748 done report ("The handler currently fires createQuick and dismisses the picker; it does NOT yet create a Claude/Terminal panel or call setActiveQuickSession. Per the plan's 'Lowest Confidence Area' and the IDEA-024 slice 3 scope, that integration is a follow-up").
- **Problem:** `CyboflowRoot.tsx:51-63` (`handlePickQuickMode`) calls `createQuick` and dismisses the inline picker, but does not call `panelApi.createPanel({ sessionId, type: ... })`, `useCyboflowStore.getState().setActiveQuickSession(sessionId)`, or navigate. `WorkflowPicker.handleQuickStart` (TASK-747) correctly does all three steps. The two-task split of TASK-747 and TASK-748 allowed this half-implementation to land — each task implemented part of the contract independently. The `CyboflowRoot` unit tests assert that `createQuick` is invoked but do not assert that `activeQuickSessionId` is set or that `panelApi.createPanel` is called, so the test suite does not catch the gap.
- **Proposed direction:** Preferred path is option (a) from FIND-SPRINT-037-3: extract a shared `useQuickSession` hook (or `createQuickSessionFull` helper) that encapsulates the full lifecycle — `createQuick → panelApi.createPanel → setActiveQuickSession → optional callback` — and call it from both `WorkflowPicker.handleQuickStart` and `CyboflowRoot.handlePickQuickMode`. This removes the divergence surface entirely. The reference pattern for the full sequence already exists in `WorkflowPicker.tsx` (TASK-747). As part of the same task, add a `CyboflowRoot` test that asserts `panelApi.createPanel` is called and `activeQuickSessionId` is set after picker selection. Also address FIND-SPRINT-037-4 (dead `API.sessions.createQuick` wrapper + duplicated payload literal) in the same pass by routing both call sites through the shared hook, which should call `API.sessions.createQuick` (or `window.electronAPI.sessions.createQuick` if that is the agreed pattern — the policy needs to be documented either way).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified `CyboflowRoot.tsx:51-63` only calls `createQuick` while `WorkflowPicker.tsx:77-104` does the full three-step lifecycle (createPanel + setActiveQuickSession + onWorkflowStarted) — TASK-748 done report explicitly punts this as a follow-up, the picker silently produces orphan worktrees today, and folding in FIND-SPRINT-037-4's duplicated payload via the shared hook is proportional rather than overengineered.

### B3. Resolve CreateSessionRequest type-surface split — promote to shared or prune dead field
- **Summary:** `CreateSessionRequest` is declared independently in `main/` and `frontend/`, has diverged (two fields missing from the frontend copy), and contains a dead field (`quickSession`) that is declared but never read.
- **Source-Sprint:** SPRINT-037
- **Source:** FIND-SPRINT-037-5 (SPRINT-037 sprint-code-reviewer; suspected task: TASK-744).
- **Problem:** TASK-744 added `quickSession?: boolean` and `branchName?: string` to `main/src/types/session.ts:75`, but neither field was added to `frontend/src/types/session.ts`. `quickSession` is dead from inception — `grep -rn quickSession --include=*.ts main/src frontend/src` returns zero production reads. `branchName` is read by `main/src/ipc/session.ts:338` but cannot be sent from the frontend because the frontend type lacks it; callers silently rely on the server default. This is the FIND-SPRINT-024-4 silent-drop pattern in mirror form — a field the server reads that the client cannot send. Preferred fix per CLAUDE.md "shared types as the cross-package contract" guidance is to promote `CreateSessionRequest` to `shared/types/` and import from both sides (the planned `shared/types/ipc.ts` location). Alternative: delete the dead `quickSession` field from `main/src/types/session.ts` and add `branchName` to the frontend copy, with a comment documenting that both sides must be kept in sync until promotion to `shared/`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `main/src/types/session.ts:75-76` declares `quickSession` and `branchName` while `frontend/src/types/session.ts:124-142` omits both, `branchName` is consumed at `main/src/ipc/session.ts:338`, and `grep quickSession` shows zero production reads — pruning the dead field plus aligning `branchName` is a small, well-targeted change; the optional promotion to `shared/types/ipc.ts` should be deferred (CLAUDE.md already flags that location as planned) so the executor doesn't get drawn into a larger refactor.
- **Counterfactual:** If the executor's refinement step proposes building `shared/types/ipc.ts` infrastructure (vs. the minimal prune+align), downgrade scope before executing.

### B4. Wire or delete getQuickSessions — resolve forward-looking DB helper with no consumer
- **Summary:** `DatabaseService.getQuickSessions` (TASK-745) is tested but has zero production callers; either wire it into a named IPC channel and a sidebar consumer, or delete it until a real consumer appears.
- **Source-Sprint:** SPRINT-037
- **Source:** FIND-SPRINT-037-6 (SPRINT-037 sprint-code-reviewer; suspected task: TASK-745). FIND-SPRINT-037-7 is related (clearActiveQuickSession also has zero production callers); both point to the same forward-looking-but-unwired pattern from TASK-745.
- **Problem:** `main/src/database/database.ts:2138-2148` exposes `getQuickSessions(projectId?: number)` with NULL-tolerance comments and two `cyboflowSchema.test.ts` unit tests, but the only references outside the implementation are those two tests. The frontend fetches sessions exclusively via `sessions:get-all-with-projects` and filters on `session.runId`. The method is untethered infrastructure. Separately, `cyboflowStore.clearActiveQuickSession` (also TASK-745) has zero production callers — only `cyboflowStore.test.ts` and `WorkflowPicker.test.tsx` `beforeEach` reset calls. If/when a Close Quick Session UI action lands, this will be wired; until then it is test-only API surface. For `getQuickSessions`: decide YAGNI (delete method + tests) or wire (add `sessions:get-quick` IPC channel + a frontend sidebar consumer). For `clearActiveQuickSession`: at minimum, add a JSDoc comment documenting that it has no current production caller and is reserved for the planned Close Quick Session UI action.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Both findings are FIND severity `low`; `getQuickSessions` is well-documented, NULL-tolerance-tested forward-looking infrastructure for the quick-session epic (which is still `status: active`) and `clearActiveQuickSession` already documents its mutual-exclusion contract in JSDoc at `cyboflowStore.ts:18` — promoting either to a backlog task either deletes shipping infra prematurely or codifies a YAGNI-vs-wire decision the next epic slice will make naturally; better to leave both until the Close Quick Session UI action surfaces a real consumer.
- **Counterfactual:** If a future sprint adds a Quick Sessions sidebar section without discovering `getQuickSessions`, or if a reader is observed deleting `clearActiveQuickSession` as dead code, reopen as a JSDoc-only annotation task.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add IPC request-shape parity rule to CLAUDE.md — both sides of a channel must agree
- **Summary:** Add a rule to CLAUDE.md requiring that IPC request shapes (not just response types) be kept in sync between frontend and main, specifically covering the `CreateSessionRequest` split as the canonical failure example.
- **Source-Sprint:** SPRINT-037
- **Target file:** `/Users/raimundoesteva/Developer/cyboflow/CLAUDE.md`
- **Action:** insert-after the existing `**IPC handler ↔ declared \`T\` parity:**` paragraph in the TypeScript Rules section
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  --- a/CLAUDE.md
  +++ b/CLAUDE.md
  @@ -59,6 +59,8 @@
   **IPC handler ↔ declared `T` parity:** the `T` in `IPCResponse<T>` declared in `frontend/src/types/electron.d.ts` and `frontend/src/utils/api.ts` MUST match the shape the matching `main/src/ipc/*` handler actually returns at runtime — not a legacy or aspirational type. A mismatched `T` forces `as unknown as X` double-casts in every consumer and hides handler shape changes from TypeScript (FIND-SPRINT-024-4: `getJsonMessages` declared `ClaudeJsonMessage[]` while the handler returned `UnifiedMessage[]`, causing TASK-637 to silently drop all output). When changing an IPC handler's return shape, grep the channel name across `frontend/src/types/electron.d.ts`, `frontend/src/utils/api.ts`, and the handler file in the same pass.
   
  +**IPC request-shape parity (mirror of the above on the request side):** request interfaces sent frontend → main (e.g. `CreateSessionRequest`, currently dual-declared in `main/src/types/session.ts` and `frontend/src/types/session.ts`) MUST be kept in sync. A field the server reads but the client can never send silently falls back to defaults — the request-direction twin of FIND-SPRINT-024-4 (FIND-SPRINT-037-5: `branchName` added to main only; `quickSession` dead on both sides). On any IPC touch, grep the request interface name across both `*/src/types/` and verify field parity. Prefer promoting to `shared/types/ipc.ts` over maintaining a dual declaration.
  +
   **Optional `logger?` on observability classes must be passed, not omitted.** ...
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Symmetric to the existing IPC-handler-T parity rule (CLAUDE.md:59), backed by two concrete recurring failures (FIND-SPRINT-024-4 response-side, FIND-SPRINT-037-5 request-side) and verified dual-declared interfaces across `main/src/types/session.ts` (9 interfaces) and `frontend/src/types/session.ts` (14 interfaces) — the rule prevents the exact silent-drop class from biting future TASK-744-shaped work and provides a concrete grep recipe rather than abstract guidance.
- **Counterfactual:** If `shared/types/ipc.ts` ships in a subsequent sprint and `CreateSessionRequest` migrates to it, this rule becomes a no-op and should be folded into the existing IPCResponse paragraph.

---

## Reconciled Findings (informational)

No stale-open findings were detected. All FIND-SPRINT-037-* entries have `resolved_by:` blank, and no done report in SPRINT-037 contains a `**Findings resolved:**` line referencing any of them. All 7 findings were genuinely open at compound time.

FIND-SPRINT-037-7 (`clearActiveQuickSession` has no production caller) was considered for a standalone item but is subsumed by B4 — both findings describe the same forward-looking-but-unwired infrastructure from TASK-745 and are best resolved together.

FIND-SPRINT-037-4 (dead `API.sessions.createQuick` wrapper + duplicated payload literal) is subsumed by B2 — its resolution depends on the same architectural decision (shared hook vs. direct `window.electronAPI` access) that B2 must settle first.
