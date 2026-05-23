---
sprint: SPRINT-033
pending_count: 2
last_updated: "2026-05-22T21:40:00Z"
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
