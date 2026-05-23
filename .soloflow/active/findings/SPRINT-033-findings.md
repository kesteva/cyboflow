---
sprint: SPRINT-033
pending_count: 7
last_updated: "2026-05-23T05:15:50.276Z"
---
# Findings Queue

## FIND-SPRINT-033-1
- **source:** TASK-731 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/__tests__/usePanelSurface.test.tsx
- **description:** TASK-731 plan step 2 specifies "Cover the five `test_strategy.targets` behaviors above, plus a sanity test that `projectId === null` does NOT call `API.sessions.getOrCreateMainRepoSession`." AC #5 also calls out "the projectId-null no-op case". The 13 `it()` blocks fully cover targets (a)-(e) — multiple tests each — but no test exercises the `projectId === null` early-return branch (hook lines 55-59). The verifiable form of AC #5 (`grep -cE "\bit\(" ... ≥5`) is satisfied, but the prose part of the AC is not. Adding one test that calls `renderHook(() => usePanelSurface(null, ...))` and asserts `mockGetOrCreateMainRepoSession` was NOT called would close the gap.
- **suggested_action:** Add one `it('does NOT call getOrCreateMainRepoSession when projectId is null', ...)` block in a future cleanup pass.
- **resolved_by:** 

## FIND-SPRINT-033-2
- **source:** TASK-731 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** .soloflow/active/plans/standalone-terminal-panels/TASK-731-plan.md
- **description:** The TASK-731 plan's "Rejected Alternatives" section explicitly rejected moving `useSessionStore.setActiveSession` into the hook ("would silently couple the two stores in CyboflowRoot, breaking the empty-state-CTA flow"), and its step 1 sub-bullet 2 said "Do NOT port ProjectView's `useSessionStore.subscribe(...)` block". The executor moved BOTH into the hook (lines 70 and 154-167 of `frontend/src/hooks/usePanelSurface.ts`). For `setActiveSession`: the plan was written stale — commit `abe52ae` (TASK-693) already added this call to CyboflowRoot's pre-extraction code, so preserving it in the hook is correct behavior parity. For the subscribe block: the executor consolidated ProjectView's block into the hook rather than choosing option (a) `forceRefreshSession` or (b) keep-local from the plan's "Lowest Confidence Area" — a third reasonable option. The CyboflowRoot tests still pass (4/4) because they mock `getOrCreateMainRepoSession` to return `data: null`, short-circuiting the new code paths. This is not a defect, but the plan-text staleness (especially the dated "Rejected Alternatives" reasoning referencing TASK-693's fix as if it didn't exist) suggests planner / compounder should refresh `docs/CODE-PATTERNS.md` or the planning prompt to instruct planners to grep recent commits touching `files_owned` before writing "Rejected Alternatives" sections.
- **suggested_action:** Compounder: consider adding a planning-prompt instruction along the lines of "Before writing a 'Rejected Alternatives' or 'Do NOT do X' directive, grep the last 30 days of commits touching the files in `files_owned` to ensure you're not rejecting behavior that's already in main."
- **resolved_by:** 

## FIND-SPRINT-033-3
- **source:** SPRINT-033 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:218,251,292; main/src/services/cyboflow/__tests__/transitions.test.ts:48; main/src/orchestrator/__tests__/approvalRouter.test.ts:899; main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:79
- **description:** Partial migration to canonical seedApproval — TASK-727 added the seedApproval helper to main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts and updated docs/CODE-PATTERNS.md to say `Do NOT inline INSERT INTO approvals in new test files — use seedApproval`. However the migration covered only 6 test files; at least 6 inline `INSERT INTO approvals` sites remain across the existing codebase (3 in cyboflowSchema.test.ts, plus transitions.test.ts, approvalRouter.test.ts, mcpQueryHandler.test.ts). The pattern documentation now reads as if adoption is canonical, but a future task touching any of these files will see an inline INSERT and naturally clone it. Risk: silent re-divergence of the projection across tests as the schema evolves.
- **suggested_action:** Follow-up cleanup pass: rewrite the 6 inline INSERT INTO approvals sites in the test files listed above onto seedApproval(db, {...}). The transitions and approvalRouter sites already have local createTestDb so the seedApproval import requires no new fixture wiring. Where a file needs FK disabled (e.g. mcpQueryHandler.test.ts), use the disableForeignKeys overload that case-4 below recommends adding.





Suspected tasks: TASK-727

## FIND-SPRINT-033-4
- **source:** SPRINT-033 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/cancelAndRestart.test.ts:44; main/src/orchestrator/__tests__/runLauncher.test.ts:33; main/src/orchestrator/__tests__/workflowRegistry.test.ts:33; main/src/orchestrator/__tests__/runExecutor.test.ts:865; main/src/orchestrator/__tests__/inspectorQueries.test.ts:48; main/src/orchestrator/__tests__/runLifecycle.test.ts:38; main/src/orchestrator/__tests__/stuckDetector.test.ts:60; main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:33; main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts:84; main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts:99,112; main/src/ipc/__tests__/cyboflow.test.ts:40
- **description:** Local createTestDb duplication remains pervasive — after TASK-727 landed the canonical createTestDb in main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts, 11 test files still define their own local `function createTestDb`. Each one re-reads 006_cyboflow_schema.sql (or 006+007) via fs.readFileSync — exactly the duplication the canonical fixture was meant to eliminate. The fixture currently uses GATE_SCHEMA (which has a parity test pinning it to 006), so a follow-on sweep can fold the simple sites onto the canonical helper.
- **suggested_action:** Extend orchestratorTestDb.ts with two options on createTestDb: `{ includeStuckReason?: boolean, disableForeignKeys?: boolean }` to cover the two non-default cases. Then sweep the 11 listed files: replace each local createTestDb with an import from __test_fixtures__/orchestratorTestDb. The parity test in orchestratorTestDb.test.ts already gates schema drift on the GATE_SCHEMA path; consolidating broadens that coverage. Defer this to a single dedicated test-cleanup task per epic, not in-line.




Files needing migration support a couple of new fixture extensions:
  - cancelAndRestart.test.ts, stuckDetector.test.ts apply migration 007 — needs createTestDb({ includeStuckReason: true }) or similar
  - claudeCodeManagerWiring.test.ts uses createTestDbNoFk for raw_events inserts — needs createTestDb({ disableForeignKeys: true })
  - inspectorQueries.test.ts inlines an ALTER TABLE stub for migration 007

Risk: the next task that adds, renames, or removes a column in 006/007 has to update every local copy, easy to miss.

Suspected tasks: TASK-727

## FIND-SPRINT-033-5
- **source:** SPRINT-033 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** frontend/src/hooks/usePanelSurface.ts:200-238
- **description:** handlePanelClose has duplicated tail across branches — the two branches of the autoCreatePermanentPanels if/else share an identical `removePanel + setActivePanelInStore + panelApi.setActivePanel + panelApi.deletePanel` tail. Only the permanence guard (`return` for dashboard/setup-tasks) and the fallback-to-dashboard step differ. The hook was extracted (per FIND-SPRINT-032-3) specifically to consolidate duplicated panel-surface logic between CyboflowRoot and ProjectView, so re-introducing duplication inside the same hook fights the extraction motive.
- **suggested_action:** Refactor handlePanelClose to share a closeAndActivate(panelId, nextId) inner helper. Both branches then compute `next` according to their own permanence rules and call the shared core. Existing tests (13 + 16 = 16 tests; 16/16 passing) still cover the path.



Extracting a helper such as:
```
const closeAndActivate = async (panelId: string, nextId: string | undefined) => {
  removePanel(mainRepoSessionId, panelId);
  if (nextId) {
    setActivePanelInStore(mainRepoSessionId, nextId);
    await panelApi.setActivePanel(mainRepoSessionId, nextId);
  }
  await panelApi.deletePanel(panelId);
};
```

would reduce both branches to ~5 lines each and prevent drift if one branch changes (e.g. someone adding an `await` or a logging line in one place only).

Suspected tasks: TASK-731

## FIND-SPRINT-033-6
- **source:** SPRINT-033 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:130; main/src/ipc/session.ts:44
- **description:** TypedEventNarrowing constructed without logger — both production callsites pass no constructor argument:
- **suggested_action:** In claudeCodeManager.ts:130, change to `new TypedEventNarrowing(this.logger)`. The field is `readonly` and constructed in a field initializer; if that ordering does not see `this.logger` yet (TypeScript field-init runs before constructor body), move the initialization into the constructor body after `super(...)`. In ipc/session.ts:44, pass through whatever logger is in scope. Run a `grep -rn "new TypedEventNarrowing()" main/src` after to confirm both sites updated.


  main/src/services/panels/claude/claudeCodeManager.ts:130
    private readonly narrowing: TypedEventNarrowing = new TypedEventNarrowing();

  main/src/ipc/session.ts:44
    const narrower = new TypedEventNarrowing();

The class ctor accepts `logger?: Pick<ILogger, verbose>` and calls `this.logger?.verbose?.("[streamParser] unknown ClaudeStreamEvent variant type=...")` on every Zod failure. With no logger passed, those verbose lines are dropped silently — the same observability gap that motivated FIND-SPRINT-024-4 (silent UnifiedMessage[]/ClaudeJsonMessage[] mismatch). Cross-task: TASK-730 introduced the new construction; the older session.ts site predates the sprint.

Suspected tasks: TASK-730

## FIND-SPRINT-033-7
- **source:** SPRINT-033 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/ProjectView.tsx:27,42-46,49-51
- **description:** isLoadingSession two-effect pattern is fragile — ProjectView keeps a useState `isLoadingSession` controlled by two useEffects:

  // Effect 1: clears the flag once mainRepoSession resolves
  useEffect(() => { if (mainRepoSession) setIsLoadingSession(false); }, [mainRepoSession]);
  // Effect 2: sets the flag on every projectId change
  useEffect(() => { setIsLoadingSession(true); }, [projectId]);

This is observably correct today (the render of `isLoadingSession || !mainRepoSessionId` works), but encodes a small state machine across two effects without ordering guarantees. A future Strict-Mode change or a re-key on `projectId` would expose desync. The same condition is fully derivable: `const isLoadingSession = mainRepoSession == null;` removes both useEffect and the useState entirely.

Suspected tasks: TASK-731
- **suggested_action:** Replace useState + the two useEffects with the derived value `const isLoadingSession = mainRepoSession == null;`. usePanelSurface already resolves `mainRepoSession` to null/Session, so the read is constant-time. Remove the now-orphan setIsLoadingSession import. CyboflowRoot does not have this pattern (it uses inline `mainRepoSession && ...`); the two surfaces converge after the change.
