---
id: TASK-649
sprint: SPRINT-024
epic: wire-sprint-005-services
status: done
summary: "Added makeLoggerSpy factory + propagated through ClaudeCodeManager constructions; added test asserting warn via RawEventsSink INSERT-failure path (proves manager → pipeline → spy wire)."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

## Summary

Closed FIND-SPRINT-007-15 coverage gap. The wiring test now passes a real logger spy through every `new ClaudeCodeManager(...)` (post-TASK-647 file path: `main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts`). The new test "logger spy receives warn() when RawEventsSink INSERT fails" forces the sink's fail-soft catch via a fake-DB `prepare().run()` that throws and asserts `expect(logger.warn).toHaveBeenCalled()` plus that the message contains `[rawEventsSink]`.

Executor deviated from the plan's malformed-JSON path (no longer reachable post-TASK-647 file shape) to the RawEventsSink INSERT failure path — verifier confirmed this is at least as strong a wire assertion (manager → pipeline → spy still proven; an extra message-content check adds rigor).

Code-reviewer CLEAN with 1 minor follow-up (FIND-SPRINT-024-9: assertion form style nit, non-blocking).

## Verifier

APPROVED — all 7 ACs met; wire is provably exercised.

## Code review

CLEAN — 1 minor (FIND-SPRINT-024-9), not blocking. The local `makeLoggerSpy()` factory is justified — the canonical `makeSpyLogger()` from TASK-646 targets the orchestrator's `LoggerLike` shape, which is incompatible with the production `Logger` class consumed by ClaudeCodeManager + the streamParser pipeline.

## Test-writer

NO_TESTS_NEEDED. Task IS the test addition; all ACs satisfied.

## Commits

- `aedd8a7 feat(TASK-649): add makeLoggerSpy factory and logger-wire test to claudeCodeManagerWiring`
