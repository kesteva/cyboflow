---
id: TASK-404
sprint: SPRINT-011
epic: review-queue-ui
status: done
summary: "Keyboard nav (j/k/y/n) hook + visible focus ring + scroll-into-view; fix StrictMode double-mutation via useRef pattern and add afterEach(cleanup) to vitest setup"
executor_loops: 1
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_unable
---

# TASK-404 — Done (SPRINT-011)

## Context

TASK-404 was largely shipped in SPRINT-010 (commits 9f34704, 1ffecc3, d208b10). SPRINT-011 closed two real-world correctness gaps surfaced by the code reviewer + verifier:

1. **Impure state updater under React.StrictMode (round-2, commit 380158e):** `y`/`n` handlers used `setFocusedIndex(currentIndex => { void trpc...mutate(...); return currentIndex; })` to read the latest focused index, but StrictMode invokes updater functions twice in dev — doubling mutation IPC traffic. Refactored to `focusedIndexRef` + `queueRef` so the keydown handler reads via refs and mutations fire outside state-updater scope. Added 3 StrictMode regression tests wrapping `renderHook` in `<React.StrictMode>` asserting single-fire behavior.

2. **Test-listener leak (round-3, commit b722b59):** `frontend/src/test/setup.ts` didn't register `afterEach(cleanup)`, so renderHook mounts accumulated window keydown listeners across tests, inflating mutation call counts in adjacent test suites. Added the canonical RTL cleanup. Resolved verifier finding FIND-SPRINT-011-4.

## Files in Scope
- `frontend/src/hooks/useReviewQueueKeyboard.ts` (ref-based handler, ergonomic empty deps for listener effect)
- `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts` (21 tests including 3 StrictMode regressions)
- `frontend/src/components/ReviewQueueView.tsx` (focusedIndex consumer + scrollIntoView)
- `frontend/src/components/PendingApprovalCard.tsx` (isFocused ring)
- `frontend/src/test/setup.ts` (afterEach(cleanup) — out of files_owned, but verifier-prescribed unblocker)

## SPRINT-011 Commits
- `380158e fix(TASK-404): eliminate impure state-updater side effects in y/n handlers`
- `b722b59 fix(TASK-404): add afterEach(cleanup) to vitest setup — unblocks hook listener tests`

## Verification
- Tests: 21/21 hook file, 99/99 frontend, typecheck + lint clean
- Visual: mobile skipped (user pref); web skipped_unable per-task — deferred to sprint-level verifier (Step 3.5)

## Findings
- Resolved: FIND-SPRINT-011-4 (vitest-setup afterEach cleanup) — fixed in b722b59
- Open (queued for compounder):
  - FIND-SPRINT-011-1 (canonical/shim directionality vs CODE-PATTERNS.md doc)
  - FIND-SPRINT-011-2 (orphan re-export shims at main/src/trpc/routers/{approvals,events}.ts)
  - FIND-SPRINT-011-3 (group-y hook fans out per-item approve.mutate vs card's approveRestOfRun)
  - FIND-SPRINT-011-5 (dev-server-not-running operational gap for per-task web visual verify)
