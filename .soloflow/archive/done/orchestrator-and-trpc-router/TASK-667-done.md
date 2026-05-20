---
id: TASK-667
sprint: SPRINT-025
epic: orchestrator-and-trpc-router
status: done
summary: "Diagnosed debug envelope drop as H2 (React Strict Mode tearing down stream-event listener mid-run); moved subscription from RunView useEffect to cyboflowStore module-level singleton; added isCyboflowRunId guard to events.ts spawned handler for cosmetic noise"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-667: Debug envelope drop diagnosis + fix

## Outcome

Diagnosis identified H2 (React Strict Mode's useEffect double-invoke unmounted the stream-event listener mid-run) as the most likely root cause and applied the structurally-correct fix: subscription lifecycle moved from RunView's useEffect into cyboflowStore as a module-level singleton (`_unsubscribeFn`, `_startSubscription`, `_stopSubscription`). `setActiveRun` starts the subscription; `clearActiveRun` tears it down; rapid `setActiveRun(A) → setActiveRun(B)` correctly teardown-then-restart. RunView is now subscription-free — render-only. Added `isCyboflowRunId` guard to `main/src/events.ts`'s `spawned` handler at line 510 (5th guard site, matching pattern at 826/877/939/1089) to silence "Session not found" noise for cyboflow run IDs.

The diagnosis methodology had a documented gap (FIND-SPRINT-025-17): the bridge-publish count was inferred from raw_events DB count, which is methodologically incorrect since `skipPersistence: true` means raw_events is owned by the CCM pipeline not the bridge. The fix is robust across H1a/H1b/H2 hypotheses, so the right code landed regardless.

## Scope expansion

Plan originally owned only `main/src/events.ts`. Phase 2 step 9 of the plan explicitly named `cyboflowStore.ts` and `RunView.tsx` as H2 fix targets, so claiming those files (and the new `cyboflowStore.test.ts`) was plan-prescribed, not scope creep. FIND-SPRINT-025-14/15/16 were filed as scope deviations but resolved as plan-prescribed by the verifier.

## Changes

- `main/src/events.ts` — added `isCyboflowRunId` guard to `spawned` handler (line 510)
- `frontend/src/stores/cyboflowStore.ts` — added module-level subscription singleton; `setActiveRun` now starts subscription; `clearActiveRun` now tears it down
- `frontend/src/components/cyboflow/RunView.tsx` — removed subscription useEffect; rendering only
- `frontend/src/components/cyboflow/__tests__/RunView.test.tsx` — rewritten to assert RunView does NOT manage subscription
- `frontend/src/stores/__tests__/cyboflowStore.test.ts` — new (7 tests covering subscription lifecycle + stale-closure refactor guard)
- `.soloflow/active/plans/orchestrator-and-trpc-router/TASK-667-plan.md` — Implementation Notes populated

## Commits

- `c5d8a14` — `fix(TASK-667): add isCyboflowRunId guard to spawned handler in events.ts`
- `1d86b11` — `fix(TASK-667): move stream-event subscription from RunView useEffect to store singleton`
- `1c2b2fb` — `test(TASK-667): update RunView tests and add cyboflowStore subscription lifecycle tests`
- `acb605a` — `docs(TASK-667): record diagnosis and fix in Implementation Notes`
- `a007886` — test (7): stale-closure guard for rapid A→B switch

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS (0 errors)
- pnpm test (frontend): 18/18 files, 242 tests pass (cyboflowStore: 7 tests; RunView: 5 tests)
- runEventBridge.test.ts: 22/22 pass
- shadow-verifier verdict: APPROVED_WITH_DEFERRED (1 manual smoke deferred — fresh-run envelope-flow validation against Tester-mctest project)
- code-reviewer verdict: CLEAN (2 minor stylistic notes — module-scope vs factory-closure singleton placement; not blocking)
- test-writer: TESTS_WRITTEN (added stale-closure refactor guard)

## Deferred verification (queued in human-review-queue.md)

- Run `pnpm dev`, open Tester-mctest project, kick off prune workflow, open renderer DevTools, confirm `[cyboflowApi] stream event #1, #2, #3` appear and `useCyboflowStore.getState().streamEvents.length >= 3` by `completed` (Level: goal_backward, severity: medium)

## Out-of-diff findings filed

- FIND-SPRINT-025-17 — diagnosis methodology gap (DB row count was used to infer bridge-publish count despite skipPersistence:true making them independent); medium severity for compounder review of executor diagnostic-rigor patterns
