---
id: TASK-644
sprint: SPRINT-018
epic: orchestrator-and-trpc-router
status: done
summary: "Four guarded workflow_runs transition helpers (running/completed/failed/canceled) + fully-wired cyboflow.runs.cancel tRPC mutation with strict ordering."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-644 — Done

Added `transitionToRunning`, `transitionToCompleted`, `transitionToFailed`,
`transitionToCanceled` to `main/src/services/cyboflow/transitions.ts`.
Each runs a guarded `UPDATE workflow_runs SET status = ?, updated_at =
CURRENT_TIMESTAMP WHERE id = ? AND status = ?` (or `NOT IN (...)` for
cancel) and throws `TransitionRejectedError` on `changes === 0`. Terminal
helpers (completed/failed/canceled) set `ended_at = CURRENT_TIMESTAMP`
atomically with the status change. `transitionToFailed` writes
`error_message`. `transitionToCompleted.fromStatus` is `'running'` only
(narrower than plan text, matching the authoritative `ALLOWED_TRANSITIONS`
in `stateMachine.ts`).

Wired `main/src/orchestrator/trpc/routers/runs.ts` cyboflow.runs.cancel:
added `CancelDeps`, `setCancelDeps()` injector, and exported
`cancelHandler(runId, deps)`. The handler runs `clearPendingForRun →
executor.cancel() → DB write` in strict order. `executor.cancel()` is
wrapped in try/catch (mirror of `cancelAndRestartHandler` pattern) so a
rejection still lets the DB reach `'canceled'`. Returns `{ canceled: true
}` on success or `{ canceled: false, reason: 'already_terminal' }` when
the SQL guard returns `changes === 0`. METHOD_NOT_SUPPORTED until
`setCancelDeps()` is called (deferred to a later integration task per
plan). The cancel UPDATE SQL is inlined in `cancelHandler` (does not
import `transitionToCanceled`) to preserve the runs.ts
standalone-typecheck invariant (no `main/src/services/*` imports).

Tests: 29 cases in
`main/src/orchestrator/__tests__/runLifecycle.test.ts` covering all 4
helpers (table-driven across statuses), cancelHandler ordering via
OrderSpy, null-executor branch, already-terminal race, METHOD_NOT_SUPPORTED
branch, and the executor.cancel rejection swallow regression. Full main
suite 408 tests / 41 files pass. Typecheck clean.

Code-reviewer queued FIND-SPRINT-018-5 (low): terminal-status set
(`'canceled' | 'failed' | 'completed'`) is duplicated in 3+ files — a
shared `TERMINAL_RUN_STATUSES` constant in `shared/types/cyboflow.ts`
would close the drift surface without violating the standalone-typecheck
invariant.
