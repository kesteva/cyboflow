---
sprints: [SPRINT-033]
span_label: SPRINT-033
created: 2026-05-22T22:30:00.000Z
counters_start:
  ideas: 24
summary:
  cleanups: 4
  backlog_tasks: 2
  claude_md: 2
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-033

## A. Clean-up items (execute now)

### A1. Add null-guard test for `projectId === null` in `usePanelSurface.test.tsx`
- **Summary:** The `usePanelSurface` test suite covers all five plan targets but omits the `projectId === null` early-return branch called out explicitly in AC #5, leaving one untested code path in the extracted hook.
- **Source-Sprint:** SPRINT-033
- **Rationale:** FIND-SPRINT-033-1 (verifier) flagged this gap: the hook short-circuits at lines 55-59 when `projectId` is null and never calls `getOrCreateMainRepoSession`, but no test asserts that. The plan's acceptance criteria explicitly called out this case ("the projectId-null no-op case"). Adding one `it()` block closes the stated AC without touching any production code.
- **Blast radius:** `frontend/src/hooks/__tests__/usePanelSurface.test.tsx` only. No production changes. Risk: trivial.
- **Source:** FIND-SPRINT-033-1 (TASK-731 verifier), TASK-731-done.md.
- **Proposed change:**
  ```diff
  // In frontend/src/hooks/__tests__/usePanelSurface.test.tsx
  // Add inside the top-level describe block, after the existing 16 tests:

  + it('does NOT call getOrCreateMainRepoSession when projectId is null', () => {
  +   renderHook(() =>
  +     usePanelSurface(null, mockAutoCreatePermanentPanels, mockHandlers)
  +   );
  +   expect(mockGetOrCreateMainRepoSession).not.toHaveBeenCalled();
  + });
  ```
  (Adjust mock/arg names to match the test file's existing parameter conventions.)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `frontend/src/hooks/usePanelSurface.ts:55-59` (the null short-circuit exists) and `frontend/src/hooks/__tests__/usePanelSurface.test.tsx` (16 it() blocks, zero invocations with `null` projectId — every call passes `1`); one new test is the smallest possible fix that closes the stated AC.

---

### A2. Refactor `handlePanelClose` in `usePanelSurface.ts` to share duplicated tail via `closeAndActivate` helper
- **Summary:** Both branches of `handlePanelClose` in `usePanelSurface.ts:200-238` share an identical four-call tail (`removePanel` + `setActivePanelInStore` + `panelApi.setActivePanel` + `panelApi.deletePanel`) that should be extracted into a shared inner helper to prevent silent drift.
- **Source-Sprint:** SPRINT-033
- **Rationale:** FIND-SPRINT-033-5 (sprint-code-reviewer) identified this as re-introducing duplication inside the hook that was extracted specifically to consolidate duplicated panel-surface logic (FIND-SPRINT-032-3). If one branch acquires a logging statement or an `await`, the other branch silently diverges. The 16 existing tests cover both branches and will gate the refactor correctly.
- **Blast radius:** `frontend/src/hooks/usePanelSurface.ts` only (lines 200-238). Risk: low — the 16 passing tests cover both branches.
- **Source:** FIND-SPRINT-033-5 (sprint-code-reviewer), TASK-731-done.md.
- **Proposed change:**
  ```diff
  // In frontend/src/hooks/usePanelSurface.ts, inside handlePanelClose,
  // before the if/else branches, add:

  + const closeAndActivate = async (panelId: string, nextId: string | undefined) => {
  +   removePanel(mainRepoSessionId, panelId);
  +   if (nextId) {
  +     setActivePanelInStore(mainRepoSessionId, nextId);
  +     await panelApi.setActivePanel(mainRepoSessionId, nextId);
  +   }
  +   await panelApi.deletePanel(panelId);
  + };

  // Then replace the duplicated tail in both branches with a call to closeAndActivate(panelId, next).
  // The branches retain only their own permanence guard and fallback-to-dashboard step.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at `frontend/src/hooks/usePanelSurface.ts:218-223` and `:229-234` that both branches share the identical 4-call tail (`removePanel` + conditional `setActivePanelInStore`/`panelApi.setActivePanel` + `panelApi.deletePanel`), the hook was extracted in SPRINT-032 specifically to consolidate panel-surface logic so re-introduced duplication directly fights the extraction motive, and 16 existing tests already cover both branches.

---

### A3. Pass `logger` to both `TypedEventNarrowing` production callsites
- **Summary:** Both production `TypedEventNarrowing` instantiations omit the optional `logger` argument, silently dropping verbose Zod-failure diagnostics that motivated the class's observability design.
- **Source-Sprint:** SPRINT-033
- **Rationale:** FIND-SPRINT-033-6 (sprint-code-reviewer) flagged that `TypedEventNarrowing` accepts `logger?: Pick<ILogger, 'verbose'>` and calls `this.logger?.verbose(...)` on every Zod parse failure. With no logger, those lines are silently no-ops — the same observability gap that motivated FIND-SPRINT-024-4. TASK-730 introduced the `claudeCodeManager.ts` site; the `session.ts` site predates the sprint. Both are simple constructor-call fixes.
- **Blast radius:** `main/src/services/panels/claude/claudeCodeManager.ts:130` and `main/src/ipc/session.ts:44`. Risk: low — no logic change, only enabling an already-guarded `?.verbose?.()` call.
- **Source:** FIND-SPRINT-033-6 (sprint-code-reviewer), TASK-730-done.md.
- **Proposed change:**
  ```diff
  // main/src/services/panels/claude/claudeCodeManager.ts
  - private readonly narrowing: TypedEventNarrowing = new TypedEventNarrowing();
  + // If field initializer cannot see `this.logger` yet, move to constructor body after super():
  + private readonly narrowing: TypedEventNarrowing;
  + // In constructor body:
  + this.narrowing = new TypedEventNarrowing(this.logger);

  // main/src/ipc/session.ts:44
  - const narrower = new TypedEventNarrowing();
  + const narrower = new TypedEventNarrowing(logger); // pass whatever logger is in scope

  // Verify both sites updated:
  // grep -rn "new TypedEventNarrowing()" main/src  — must return 0 matches
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `new TypedEventNarrowing()` at `claudeCodeManager.ts:130` (where `this.logger` is available via the constructor) and `ipc/session.ts:44` (logger would require threading through `projectStoredOutputs`), and the class's constructor at `typedEventNarrowing.ts:16-43` does gate every Zod-failure diagnostic on `this.logger?.verbose?.()`; the verification grep claim in the diff is incomplete — `runEventBridge.ts:155` is a third site, but C1 explicitly covers it so this remains net-correct.
- **Counterfactual:** Threading a logger into `projectStoredOutputs` ends up requiring 2+ callsite changes — but the only caller is at line 953 of the same file, so cost stays low.

---

### A4. Replace `isLoadingSession` two-effect pattern in `ProjectView.tsx` with a derived value
- **Summary:** `ProjectView.tsx` implements `isLoadingSession` as a `useState` controlled by two `useEffect` hooks, but the value is fully derivable as `mainRepoSession == null`, eliminating the state machine and its ordering-race risk.
- **Source-Sprint:** SPRINT-033
- **Rationale:** FIND-SPRINT-033-7 (sprint-code-reviewer) identified that two interdependent effects without ordering guarantees encode a small state machine that could desync under React Strict Mode changes or re-key on `projectId`. Since `usePanelSurface` already resolves `mainRepoSession` to `null | Session`, the derived value `const isLoadingSession = mainRepoSession == null` is a constant-time read. `CyboflowRoot` already uses the inline `mainRepoSession && ...` pattern — this change makes both surfaces consistent.
- **Blast radius:** `frontend/src/components/ProjectView.tsx` (lines 27, 42-46, 49-51). Removes one `useState`, two `useEffect` calls, and the orphan `setIsLoadingSession` import. Risk: low — render output is identical; existing tests remain valid.
- **Source:** FIND-SPRINT-033-7 (sprint-code-reviewer), TASK-731-done.md.
- **Proposed change:**
  ```diff
  // frontend/src/components/ProjectView.tsx

  - const [isLoadingSession, setIsLoadingSession] = useState(true);
  + const isLoadingSession = mainRepoSession == null;

  // Remove Effect 1 (clears flag when mainRepoSession resolves):
  - useEffect(() => {
  -   if (mainRepoSession) setIsLoadingSession(false);
  - }, [mainRepoSession]);

  // Remove Effect 2 (sets flag on projectId change):
  - useEffect(() => {
  -   setIsLoadingSession(true);
  - }, [projectId]);

  // Remove orphan import of setIsLoadingSession if it was named or imported separately.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `frontend/src/components/ProjectView.tsx:27,42-46,49-51` that the two-effect pattern exists (current initial value is `useState(false)`, not `true` as the proposal states, but the derived `mainRepoSession == null` correctly produces `true` initially since `usePanelSurface` initializes `mainRepoSession` to `null`); replacing two effects + one useState with a one-line derived value is the smallest possible fix and removes a real ordering-race surface.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Migrate remaining 6 inline `INSERT INTO approvals` sites to `seedApproval`
- **Summary:** Six inline `INSERT INTO approvals` statements across four test files were intentionally deferred from TASK-727's migration sweep and should be consolidated onto the canonical `seedApproval` fixture to close the re-divergence risk documented by the sprint code-reviewer.
- **Source-Sprint:** SPRINT-033
- **Source:** FIND-SPRINT-033-3 (sprint-code-reviewer), TASK-727-done.md.
- **Problem:** TASK-727 established `seedApproval` as the canonical fixture and updated `docs/CODE-PATTERNS.md` with `Do NOT inline INSERT INTO approvals in new test files — use seedApproval`. However, 6 inline INSERT sites were explicitly deferred as out-of-scope:
  - `main/src/database/__tests__/cyboflowSchema.test.ts:218, 251, 292` (3 sites)
  - `main/src/services/cyboflow/__tests__/transitions.test.ts:48`
  - `main/src/orchestrator/__tests__/approvalRouter.test.ts:899`
  - `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:79`
  
  The documentation now reads as canonical but the codebase has 6 visible counter-examples. Any developer touching these files will naturally clone the inline pattern. The `mcpQueryHandler.test.ts` site also needs a `disableForeignKeys` approach since it inserts `raw_events` without full FK chains (similar to the `createTestDbNoFk` pattern from TASK-730).
- **Proposed direction:** Extend `orchestratorTestDb.ts:createTestDb` with two options — `createTestDb({ includeStuckReason?: boolean, disableForeignKeys?: boolean })` — to cover the two non-default cases seen in the deferred files (`cancelAndRestart.test.ts` and `stuckDetector.test.ts` apply migration 007; `mcpQueryHandler.test.ts` needs FK disabled). Then sweep each of the 6 listed files: replace inline `INSERT INTO approvals` with `seedApproval(db, { runId: ... })`. The `transitions.test.ts` and `approvalRouter.test.ts` sites already have local `createTestDb` — `seedApproval` import requires no new fixture wiring. The `mcpQueryHandler.test.ts` site needs the `disableForeignKeys` option added first. Run `grep -rn "INSERT INTO approvals" main/src` afterward to confirm 0 inline sites remain in test files.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms exactly the 6 cited inline `INSERT INTO approvals` sites (`cyboflowSchema.test.ts:218,251,292`; `transitions.test.ts:48`; `approvalRouter.test.ts:899`; `mcpQueryHandler.test.ts:79`) and the canonical `seedApproval` helper at `orchestratorTestDb.ts:111` + the CODE-PATTERNS.md rule at `docs/CODE-PATTERNS.md:146` is already in place — closing the divergence between rule and code is high-value and the scope is bounded.

---

### B2. Consolidate the 11 remaining local `createTestDb` definitions onto the canonical `orchestratorTestDb` fixture
- **Summary:** Eleven test files across the main workspace still define their own local `createTestDb` functions reading SQL from disk, duplicating the canonical fixture that TASK-727 landed and defeating the parity test that gates schema drift.
- **Source-Sprint:** SPRINT-033
- **Source:** FIND-SPRINT-033-4 (sprint-code-reviewer), TASK-727-done.md.
- **Problem:** The canonical `createTestDb()` in `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` (with `GATE_SCHEMA` and the `orchestratorTestDb.test.ts` parity test) was designed to be the single point of schema truth for test bootstrapping. But 11 files still define their own local version, each reading `006_cyboflow_schema.sql` (or `006+007`) via `fs.readFileSync` at test time:
  - `main/src/orchestrator/__tests__/cancelAndRestart.test.ts:44`
  - `main/src/orchestrator/__tests__/runLauncher.test.ts:33`
  - `main/src/orchestrator/__tests__/workflowRegistry.test.ts:33`
  - `main/src/orchestrator/__tests__/runExecutor.test.ts:865`
  - `main/src/orchestrator/__tests__/inspectorQueries.test.ts:48`
  - `main/src/orchestrator/__tests__/runLifecycle.test.ts:38`
  - `main/src/orchestrator/__tests__/stuckDetector.test.ts:60`
  - `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:33`
  - `main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts:84`
  - `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts:99, 112`
  - `main/src/ipc/__tests__/cyboflow.test.ts:40`

  The next task that renames or adds a column in migration 006/007 must update every local copy — easy to miss, and the parity test only covers the canonical fixture. Three non-standard cases need fixture options before the sweep can proceed: `cancelAndRestart.test.ts` and `stuckDetector.test.ts` apply migration 007 (needs `includeStuckReason: true` or similar); `claudeCodeManagerWiring.test.ts` uses `createTestDbNoFk` (needs `disableForeignKeys: true`); `inspectorQueries.test.ts` inlines an ALTER TABLE stub for migration 007.
- **Proposed direction:** This can be sequenced after B1 (which requires the same `createTestDb` option extensions). Add `includeStuckReason` and `disableForeignKeys` options to `orchestratorTestDb.ts:createTestDb`, then sweep each of the 11 listed files, replacing their local `createTestDb` with an import from `__test_fixtures__/orchestratorTestDb`. Delete each local implementation once replaced. Run `grep -rn "function createTestDb" main/src` afterward to confirm 0 remaining local definitions. The parity test in `orchestratorTestDb.test.ts` then gates schema drift for all 11 previously-uncovered files.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Grep confirms 12 local `function createTestDb` definitions in test files (11 in the cited list plus a `createTestDbNoFk` in `claudeCodeManagerWiring.test.ts:112` that the proposal also notes); the canonical fixture's parity test is undermined as long as 11 forks read schema SQL via `fs.readFileSync`, so the next migration column-change would silently miss them — concrete pain that the consolidation prevents. Sequencing after B1 is sound since both need the same fixture-option extensions.
- **Counterfactual:** A medium-scope sweep across 11 test files carries some risk of churn; if any of these test files are in active in-flight rework, defer until that settles — but no active plan touches these files currently.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Add a rule to CLAUDE.md: pass loggers to observability-augmented constructors
- **Summary:** Two production callsites constructed `TypedEventNarrowing` without passing the optional `logger`, silently suppressing all Zod-failure diagnostics, which mirrors the exact silent-drop pattern that motivated FIND-SPRINT-024-4.
- **Source-Sprint:** SPRINT-033
- **Target file:** `/Users/raimundoesteva/Developer/cyboflow/CLAUDE.md`
- **Action:** insert-after the `**IPC handler ↔ declared \`T\` parity:**` bullet at the end of the `## TypeScript Rules` section
- **Status:** ready
- **source_item:** C2
- **Diff:**
  ```diff
  @@ ## TypeScript Rules @@
   **IPC handler ↔ declared `T` parity:** the `T` in `IPCResponse<T>` declared in `frontend/src/types/electron.d.ts` and `frontend/src/utils/api.ts` MUST match the shape the matching `main/src/ipc/*` handler actually returns at runtime — not a legacy or aspirational type. A mismatched `T` forces `as unknown as X` double-casts in every consumer and hides handler shape changes from TypeScript (FIND-SPRINT-024-4: `getJsonMessages` declared `ClaudeJsonMessage[]` while the handler returned `UnifiedMessage[]`, causing TASK-637 to silently drop all output). When changing an IPC handler's return shape, grep the channel name across `frontend/src/types/electron.d.ts`, `frontend/src/utils/api.ts`, and the handler file in the same pass.
  +
  +**Optional `logger?` on observability classes must be passed, not omitted.** Constructors that accept `logger?: Pick<ILogger, ...>` (e.g. `TypedEventNarrowing`, `RawEventsSink`, `MessageProjection`) gate every diagnostic on `this.logger?.…` — omitting the argument silently turns the whole class into a no-op for observability. This is the same silent-drop pattern as FIND-SPRINT-024-4 and FIND-SPRINT-033-6. Pass a logger from the enclosing scope. Audit on touch: `grep -rn "new TypedEventNarrowing()" main/src` must return 0 matches (also covers `runEventBridge.ts:155`, missed by the original A3 sweep).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified that the three cited classes all accept `logger?: Pick<ILogger, ...>` (`typedEventNarrowing.ts:16`, `rawEventsSink.ts:43`, `messageProjection.ts:39`) and that `MessageProjection` at `ipc/session.ts:45` is also constructed without a logger today, so the same silent-drop pattern spans multiple classes (not just one); precedent across FIND-SPRINT-024-4 and FIND-SPRINT-033-6 shows the trap is recurring rather than a one-off, and the rule is short and concrete enough that the attention-budget cost is small.
- **Counterfactual:** If `RawEventsSink` / `MessageProjection` constructors were standardized to require `logger` (non-optional), the rule would be obsolete; that refactor is not in flight.

---

### C2. Add `createTestDb` extension options to CODE-PATTERNS.md [dropped — stale]
- **Source-Sprint:** SPRINT-033
- **Summary:** The original proposal would have documented `createTestDb({ includeStuckReason?, disableForeignKeys? })` options in CODE-PATTERNS.md alongside `seedApproval`.
- **Reason:** `createTestDb()` does not accept options today — the proposed options would be introduced by Bucket B (B1/B2) when they consolidate the inline INSERTs and local createTestDb forks. Documenting an unimplemented API surface in CODE-PATTERNS.md now would mislead future readers (they would look for options that aren't there yet) and the doc would silently rot if B1/B2 reshape the option names during execution. Re-introduce this C-item from whichever sprint actually lands B1/B2; at that point the JSDoc on `createTestDb` and CODE-PATTERNS.md can be updated atomically with the implementation.

---

## Suppressed — SoloFlow Defects

- **Planner "Rejected Alternatives" written without checking recent commits** — FIND-SPRINT-033-2 recommends that planners grep the last 30 days of commits touching `files_owned` before writing "Do NOT do X" or "Rejected Alternatives" directives, to avoid rejecting behavior already present in main (TASK-731 plan rejected `setActiveSession` in the hook but commit `abe52ae` / TASK-693 had already added it). This is a SoloFlow planner-agent behavior defect — the rule would evaporate if the user stopped using SoloFlow and the fix belongs in the planner prompt, not in project CLAUDE.md. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.

---

## Reconciled Findings (informational)

No stale-open findings were found to have been claimed as resolved in SPRINT-033 done reports. All seven `FIND-SPRINT-033-*` findings carry `status: open` and none appear in any done report's `**Findings resolved:**` block.
