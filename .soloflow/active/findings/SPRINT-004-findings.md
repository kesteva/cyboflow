---
sprint: SPRINT-004
pending_count: 1
last_updated: "2026-05-13T00:00:00Z"
---

# Findings Queue

## FIND-SPRINT-004-1
- **source:** TASK-101 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** .soloflow/active/plans/typed-stream-event-schema/TASK-101-plan.md
- **description:** Plan was refined (87 → 159 lines) on `main` after the executor authored the initial implementation against the 87-line draft. Step 7 (per-variant JSDoc camelCase-exception annotations) was added in the refinement but never reached the executor, causing the executor to ship the implementation without one of the three required JSDoc notes (`ResultEvent.modelUsage`). Soloflow's plan-refinement workflow should either (a) re-spawn the executor when an in-flight plan is refined with new implementation steps, or (b) treat refinement-on-an-in-flight-plan as a protocol violation requiring an explicit re-plan. Compounder: consider documenting which plan revisions are safe to merge mid-flight vs. which require restarting the executor.
- **suggested_action:** Add guidance in plan-refinement docs: if `status: in-flight`, refinements may not introduce new implementation steps or new acceptance-criteria sub-clauses; only clarify existing ones.
- **resolved_by:**
