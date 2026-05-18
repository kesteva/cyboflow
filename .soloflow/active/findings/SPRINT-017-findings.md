---
sprint: SPRINT-017
pending_count: 5
last_updated: "2026-05-18T23:15:00.000Z"
---
# Findings Queue

SPRINT-017 started with missing infra: docker; tests deferred.

## FIND-SPRINT-017-6
- **source:** TASK-616 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/approvals.ts:4-8
- **description:** The file-header docstring listing the procedures exposed by `cyboflow.approvals` was updated in TASK-406 to include `approveRestOfRun` but was not updated in TASK-616 to include `rejectRestOfRun`. The new procedure is correctly defined and documented inline (lines 121-149), but the top-of-file procedure index is now stale — readers grepping the header to enumerate the surface will miss `rejectRestOfRun`. Pure docstring; no behavioral impact.
- **suggested_action:** Add `*   - rejectRestOfRun   : mutation → { decided: number } (TASK-616 — per-run batch reject)` line after the `approveRestOfRun` bullet at line 8.
- **resolved_by:** 

## FIND-SPRINT-017-5
- **source:** TASK-608 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/index.ts:673-684
- **description:** TASK-608 extracted `makeLoggerLike` into `main/src/orchestrator/loggerAdapter.ts` so it could be imported by both `index.ts` (AppServices assembly at line 550) and `cyboflow.ts`. The new helper is now used for `cyboflowLogger`, but the older tRPC-orchestrator block (lines 673-684) still defines its own inline `db: DatabaseLike` adapter AND a separate inline `loggerLike` adapter that wraps the same `logger` instance. Two divergences result: (a) the tRPC inline `loggerLike` discards `ctx` (no second-arg handling), while `makeLoggerLike` preserves it via JSON.stringify; (b) the inline `db` adapter at 673-676 has a body byte-identical to the new `cyboflowDb` adapter at 554-557. Both could now collapse into shared helpers (`makeLoggerLike(logger)` and a `makeDatabaseLike(databaseService)` factory).
- **suggested_action:** Replace lines 673-684 with `const db = makeDatabaseLike(databaseService); const loggerLike = makeLoggerLike(logger);` once a `makeDatabaseLike` helper is added next to `makeLoggerLike` in `main/src/orchestrator/loggerAdapter.ts` (or a sibling `dbAdapter.ts`). Eliminates one DRY violation and unifies context-forwarding semantics across all orchestrator-style adapters in `index.ts`.
- **resolved_by:** 

## FIND-SPRINT-017-4
- **source:** TASK-613 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** .soloflow/active/findings/SPRINT-010-findings.md (FIND-SPRINT-010-1)
- **description:** TASK-613 executor logged a scope_deviation finding to SPRINT-010-findings.md instead of the active sprint's SPRINT-017-findings.md. The executor also misclassified the edit as a scope deviation — all 11 frontend test files modified are explicitly listed in the plan's `files_owned` (lines 9-19 of TASK-613-plan.md). The plan's step 1 said "Expected: three matches" for the pre-flight grep, but that was a pre-flight expectation, not an authorization boundary. Two issues: (a) executor agent appears to use a stale `sprint.id` when writing findings (writing to a non-active sprint's file); (b) the agent classified an in-scope edit as a deviation because the implementation-step prose mentioned a smaller number than the frontmatter `files_owned` list.
- **suggested_action:** (a) Add an executor-side guard that re-reads `.soloflow/sprint.json` (or the orchestrator-injected sprint id) immediately before appending to a findings file, never derive it from cached context. (b) Tighten the executor scope-deviation prompt so a file is only flagged as a deviation when it is OUTSIDE `files_owned`, regardless of whether the implementation-step prose names every file individually. The current FIND-SPRINT-010-1 is already AC-prescribed and should be flipped to resolved by the verifier — see verification report.
- **resolved_by:** 

## FIND-SPRINT-017-1
- **source:** TASK-611 (executor)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** frontend/src/components/ReviewQueueView.tsx:9
- **description:** Local interface IPCResponse<T> declared at line 9. CLAUDE.md forbids this — callers must import from frontend/src/utils/api.ts instead. The declaration pre-dates TASK-611 and was not introduced by it.
- **suggested_action:** Replace the local IPCResponse declaration with an import from frontend/src/utils/api.ts and add explicit type parameter to the invoke call.
- **resolved_by:** 

## FIND-SPRINT-017-2
- **source:** TASK-586 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/Orchestrator.ts:58
- **description:** `Orchestrator.start()` constructs `StuckDetector` with `emitter: new EventEmitter()` — a fresh, inline-constructed emitter that is never stored on `this`, never exposed via a getter, and never returned. Combined with `private detector?: StuckDetector` and `StuckDetector.emitter` being a `private readonly` field with no accessor, this means every `runs:stuck` event emitted by `StuckDetector.transitionRunsToStuck()` (stuckDetector.ts:282) is unreachable by any subscriber outside the test harness. This is functionally equivalent to a `void` sink — the per-component emitter pattern documented in ARCHITECTURE.md §Orchestrator says "callers subscribe directly", but no caller can subscribe to *this* emitter because it has no public reference. The decision to drop the shared `eventBus` was correct (path b in the TASK-586 plan); the implementation choice of an *inline-anonymous* emitter, however, recreates the same "did anyone wire this?" failure mode that motivated the drop — except now the symptom is invisible until a subscriber is added. The TASK-586 plan's "Hardest Decision" section anticipated this: "When the first real consumer needs cross-producer event aggregation, that consumer's plan will design the bus." That consumer's plan will need to add either (a) an `emitter` getter on `Orchestrator`, (b) an `emitter` getter on `StuckDetector` plus exposing `detector` on `Orchestrator`, or (c) accept `emitter` as an optional `OrchestratorDeps` field so the caller owns the lifecycle.
- **suggested_action:** When the first `runs:stuck` consumer task lands (likely in the stream-parser-to-main or admin-UI epic), add an `Orchestrator.onStuck(listener)` method (or expose `stuckEmitter: EventEmitter` as a read-only getter) so subscription paths are part of the public surface. Until then, leave the inline emitter — it correctly isolates the dead-event surface from the renderer and matches the "no speculative wiring" decision. This finding is a forward-looking reminder, not a blocker for TASK-586.
- **resolved_by:** 

## FIND-SPRINT-017-3
- **type:** scope_deviation
- **source:** TASK-600 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/utils/cyboflowApi.ts
- **description:** required to meet AC: plan step 6 explicitly instructs updating the cyboflow comment in this file; it was listed as files_readonly but the plan implementation step targets it directly
- **resolved_by:** verifier — plan-prescribed: TASK-600 step 6 explicitly instructs rewriting the "When tRPC lands in epic 6, swap the internals" comment in frontend/src/utils/cyboflowApi.ts. The file also appears in files_owned (line 12) alongside files_readonly (line 20) — plan-frontmatter inconsistency, but files_owned authorizes the edit and step 6 prescribes it.
