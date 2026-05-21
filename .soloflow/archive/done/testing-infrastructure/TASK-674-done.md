---
id: TASK-674
sprint: SPRINT-027
epic: testing-infrastructure
status: done
summary: "Duplicate of TASK-671 — both targeted the same 4 stale assertions in runExecutor.test.ts. Acceptance criteria already met by TASK-671's commit a5f0a83."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-674 — Done (Duplicate of TASK-671)

## Resolution
TASK-674 is functionally identical to TASK-671: both target the same `main/src/orchestrator/__tests__/runExecutor.test.ts` file and the same 4 stale assertions broken by commit 715b6c9 (pre_spawn -> running() routing).

TASK-671's commit a5f0a83 already:
- Updated the four assertions to match production (pre_spawn + sdk_initialized both call running()).
- Added inline comments explaining the double-call semantics.
- Preserved makeSpyLogger usage.

## Verification
`pnpm exec vitest run src/orchestrator/__tests__/runExecutor.test.ts` -> 26/26 pass. All four named test cases appear in the passing list.

## Finding for compound
SoloFlow workflow defect: the compounder produced overlapping plans across SPRINT-024-compound (TASK-671) and SPRINT-025-compounder (TASK-674) for the same defect. Consider improving deduplication in compound's task-extraction step.

## Commit
No new commit — work landed under TASK-671 commit a5f0a83.
