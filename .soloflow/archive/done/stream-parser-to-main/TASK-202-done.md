---
id: TASK-202
sprint: SPRINT-005
epic: stream-parser-to-main
status: done
summary: "CompletionDetector — triple-gate (childExited + stdoutEof + parserDrained) with 30s watchdog and forced-failure path"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-202 — Done Report

## Summary

Created `main/src/services/streamParser/completionDetector.ts` — `CompletionDetector extends EventEmitter` with three signal methods (`signalChildExited`, `signalStdoutEof`, `signalParserDrained`), 30-second watchdog timer, and `dispose()` for clean shutdown. Emits `'complete'` (reason='all_signals') ONLY when all three signals fire, or `'forced'` (reason='watchdog_timeout', missing=[...]) if the watchdog fires first. NEVER consults the Claude `result` event — that event is unreliable per Anthropic's closed-not-planned bugs (#1920, #25629).

The `emitted` flag is set BEFORE `emit()` in both paths so any synchronous re-entry from a listener is idempotent. `startWatchdogIfNeeded()` is itself idempotent (guards on existing timer). `dispose()` clears the timer, sets `disposed=true`, and `removeAllListeners()` so no late signal can revive a disposed detector.

## Changes

- `main/src/services/streamParser/completionDetector.ts` (new)
- `main/src/services/streamParser/__tests__/completionDetector.test.ts` (new — 18 unit tests using vitest fake timers)

## Commits

- `3d21b78` — `feat(TASK-202): add CompletionDetector triple-gate with 30s watchdog`

## Verification

- Tests: 18/18 completionDetector cases pass (vitest fake timers, deterministic).
- Typecheck: PASS.
- Lint: PASS.
- Per-task visual: skipped (parallel mode).

## Notes

- Constructor accepts a configurable `watchdogMs` (default 30_000ms) strictly for testing; production callers should use the default. The 30s value is grounded in IDEA-005 + architecture research §1.
- Wiring into `claudeCodeManager` is deferred to TASK-205 or a later orchestrator task — TASK-202 ships only the detector itself.
