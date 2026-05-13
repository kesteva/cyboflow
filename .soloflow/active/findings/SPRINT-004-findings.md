---
sprint: SPRINT-004
pending_count: 2
last_updated: "2026-05-13T16:30:00Z"
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

## FIND-SPRINT-004-2
- **source:** TASK-102 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/schemas.ts:152-159
- **description:** `resultSubtypeEnum` is declared but never used at runtime — it exists only to satisfy AC #6's grep gate (`z.enum(['success', ...`). The actual schema uses four `z.literal(...)` sibling schemas inside `z.discriminatedUnion('subtype', ...)` because `discriminatedUnion` branches must pin discriminants with `z.literal`, not `z.enum`. A `void resultSubtypeEnum` line silences the unused-binding lint. This is intentional (the plan's "Rejected Alternatives" documents the tension) but leaves behind a dead binding whose only purpose is to satisfy a grep. Either (a) replace the four `z.literal` siblings with a single resultEventSchema that uses `subtype: resultSubtypeEnum` and drop the discriminatedUnion('subtype') performance optimization, or (b) delete `resultSubtypeEnum` and rewrite AC #6 to grep for the four `z.literal('success' | 'error_max_turns' | ...)` declarations directly. Defer to TASK-103 timing — once the fixture suite is green, the dead enum can be removed without losing coverage.
- **suggested_action:** Delete `resultSubtypeEnum` after TASK-103 lands. The schema's actual subtype coverage is enforced by the four `z.literal` sibling schemas plus the inner discriminatedUnion, which TASK-103's `result` subtype fixtures will verify behaviorally.
- **resolved_by:**
