---
id: TASK-662
sprint: SPRINT-021
epic: orchestrator-and-trpc-router
status: done
summary: "Wire onFirstMessage bridge callback + LifecycleTransitionsLike adapter into RunExecutor; execute() now fires completed/failed; index.ts wires real LifecycleTransitions + EventEmitter source — closes IDEA-018 wiring."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-662 — Done report

## Outcome
- Added `onFirstMessage?: (firstTyped: ClaudeStreamEvent) => void` to `BridgeEventsOptions`; single-shot guard, fail-soft try/catch.
- Added `LifecycleTransitionsLike` interface + injected adapter into RunExecutor. `onLifecycleTransition` now routes phase → transitionTo* helpers; race-tolerant (TransitionRejectedError → warn log).
- `execute()` try/catch now fires `'completed'` on success and `'failed'` on throw; cancel still owned by `cancel()` (no duplication).
- Added optional `source?: EventEmitter` 8th constructor arg (review round 2) so `bridgeEvents()` reads its event source cleanly; `defaultCliManager` is passed as source from `index.ts`.
- Renamed `placeholderRunExecutor` → `runExecutor` in `index.ts` (no longer a placeholder after this wiring).

## Commits
- `ff40369` feat(TASK-662): add onFirstMessage single-shot callback to runEventBridge
- `02951ea` feat(TASK-662): wire LifecycleTransitionsLike + onFirstMessage into RunExecutor
- `a4d0b39` feat(TASK-662): wire LifecycleTransitions adapter in index.ts construction site
- `af362a4` test(TASK-662): add 8 new unit tests for onFirstMessage and lifecycle transitions
- `9539688` refactor(TASK-662): add source constructor arg to RunExecutor, drop unsafe cast in bridgeEvents default
- `22aa3ae` test(TASK-662): add 2 tests covering source arg integration + absence

## Verifier verdict
APPROVED_WITH_DEFERRED — AC9 manual smoke (`pnpm dev`, Start Run, confirm status flips in backend-debug.log) deferred to human queue. Verifier also resolved FIND-SPRINT-021-1 (the missing `'failed'` transition) since this task implements its suggested fix (option a).

## Code-reviewer verdict
Round 1: IMPROVEMENTS_NEEDED (Important x2 — unsafe `as unknown as` cast hiding latent runtime crash; stale `placeholderRunExecutor` identifier).
Round 2: CLEAN.

## Follow-ups
- Manual smoke (AC9) queued at `.soloflow/human-review-queue.md` (TASK-662 testing bucket).
