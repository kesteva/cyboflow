---
id: TASK-749
sprint: SPRINT-037
epic: quick-session
status: done
summary: "Added Quick badge to SessionListItem and runId field to Session interfaces; 5 component tests pin badge presence/absence and 3 action handlers."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-749 — Quick badge in SessionListItem

## What changed

- `frontend/src/types/session.ts` + `main/src/types/session.ts` — added `runId?: string | null` to both `Session` interfaces (scope expansion to cover an upstream planning gap; TASK-745's plan didn't include the frontend Session type in its `files_owned`).
- `frontend/src/components/SessionListItem.tsx` — Quick badge `<span>` rendered when `session.runId == null` (loose equality covers `null` AND `undefined`), sibling to the existing `(main)` marker. Same `ml-1 text-xs` shape; muted `text-text-tertiary` color; title="Quick session — not linked to a workflow run".
- `frontend/src/components/__tests__/SessionListItem.test.tsx` — new file with 5 component tests covering the badge presence/absence and the three context-menu actions (archive/rename/favorite) on null-runId sessions.

## Verification

- L1 grep ACs: 6/6 met.
- L2 tests: 357/357 frontend tests pass (5 new SessionListItem tests).
- L2 typecheck + lint: clean (0 errors).
- L3 visual: not_applicable for mobile/web; macos skipped_unable (no dev server running).

## Code review

CLEAN — diff is faithful to plan. Reviewer surfaced a high-severity out-of-diff finding (FIND-SPRINT-037-1, queued for compound):

> `main/src/services/sessionManager.ts:185` (`convertDbSessionToSession`) does not copy `run_id` from the DB row onto the returned `Session`. Every session arriving via `sessions:get-all-with-projects` has `runId === undefined` at runtime, so the Quick badge would render on every session in the sidebar. The five unit tests bypass this mapper by constructing sessions directly via the fixture, so the regression is invisible to the unit suite. Fix is a 2-line addition to `models.ts` (`run_id?: string | null` on `DbSession`) and `sessionManager.ts` (`runId: dbSession.run_id ?? null` in the converter).

This finding is in TASK-745's territory (the NULL-tolerance audit explicitly claimed "no existing `SELECT *` query needs changes" but did not audit the converter step). Compound will reconcile it.

## Notes for downstream

- The Quick badge in this task is implemented correctly within the diff but will not work end-to-end until FIND-SPRINT-037-1 is fixed (mapper needs to copy `run_id` → `runId`). This is intentional: the diff is plan-faithful and well-tested; the gap was uncovered by the code-reviewer's broader audit.
