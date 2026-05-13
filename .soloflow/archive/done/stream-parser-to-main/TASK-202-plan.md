---
id: TASK-202
idea: IDEA-005
idea_id: IDEA-005
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/services/streamParser/completionDetector.ts
  - main/src/services/streamParser/__tests__/completionDetector.test.ts
files_readonly:
  - main/src/services/streamParser/streamParser.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - .soloflow/active/research/ROADMAP-001-research-ecosystem.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "main/src/services/streamParser/completionDetector.ts exports a CompletionDetector class with three input signals (childExited, stdoutEof, parserDrained) and one output event ('complete' | 'forced')."
    verification: "grep -n \"export class CompletionDetector\" main/src/services/streamParser/completionDetector.ts returns 1 match; grep -n \"signalChildExited\\|signalStdoutEof\\|signalParserDrained\" main/src/services/streamParser/completionDetector.ts returns 3+ matches."
  - criterion: "All three signals must fire before the detector emits 'complete'. After only 1 signal, no emission. After only 2 signals, no emission. After all 3, exactly one 'complete' emission with no 'forced' emission."
    verification: "pnpm --filter main test -- completionDetector.test.ts passes; test asserts the three partial-signal cases yield zero emissions and the all-three case yields exactly one 'complete' emission."
  - criterion: "30-second watchdog: if 30s elapse after the first signal arrives without all three signals firing, the detector emits 'forced' exactly once. After 'forced', further signals do not produce another emission."
    verification: "pnpm --filter main test -- completionDetector.test.ts passes; uses vitest fake timers (vi.useFakeTimers) to fire signalChildExited, advance 30001ms, assert one 'forced' emission, then fire remaining signals and assert no additional emission."
  - criterion: "The 'forced' path is distinguishable from the 'complete' path: 'complete' indicates clean shutdown, 'forced' indicates the watchdog fired (run should be marked failed per IDEA-005 constraint)."
    verification: "grep -n \"emit('complete'\\|emit('forced'\" main/src/services/streamParser/completionDetector.ts shows at least one match for each event name; emitted event payload includes a 'reason' field with values 'all_signals' or 'watchdog_timeout'."
  - criterion: Detector never relies on the Claude `result` event as a gate-opener. The three signals are (child exited) AND (stdout EOF) AND (parser queue drained) — `result` is not one of them.
    verification: "grep -n \"result\" main/src/services/streamParser/completionDetector.ts returns no matches against the strings 'result' as an input signal name (matches against the word in comments or 'forced' results are acceptable; assert the signal method names are exactly signalChildExited/signalStdoutEof/signalParserDrained)."
  - criterion: "Detector is reusable per-run: each new run gets its own CompletionDetector instance. Calling .dispose() clears the watchdog timer and prevents any further emissions even if signals arrive late."
    verification: "pnpm --filter main test -- completionDetector.test.ts passes; test creates a detector, calls .dispose(), then fires all three signals and asserts no 'complete' or 'forced' emission and no pending timers (vi.getTimerCount() === 0)."
depends_on:
  - TASK-201
estimated_complexity: low
epic: stream-parser-to-main
test_strategy:
  needed: true
  justification: "The triple-gate completion + 30s watchdog is the mandatory mitigation for Anthropic's closed-not-planned result-event bug (issue #1920, #25629). Logic is purely temporal and AND-gated; missing test coverage here directly maps to runs hanging indefinitely in production. Vitest's fake timers make this deterministic to test."
  targets:
    - behavior: "All three signals fire → exactly one 'complete' emission with reason 'all_signals'."
      test_file: main/src/services/streamParser/__tests__/completionDetector.test.ts
      type: unit
    - behavior: Partial signal sets (1 or 2 of 3) produce zero emissions before watchdog fires.
      test_file: main/src/services/streamParser/__tests__/completionDetector.test.ts
      type: unit
    - behavior: "30s watchdog fires exactly once if all three signals not received in time; subsequent signals do not double-emit."
      test_file: main/src/services/streamParser/__tests__/completionDetector.test.ts
      type: unit
    - behavior: dispose() cancels watchdog and prevents future emissions; verified via vi.getTimerCount() and signal replay.
      test_file: main/src/services/streamParser/__tests__/completionDetector.test.ts
      type: unit
---
# Triple-gate completion detector with 30s watchdog

## Objective

Build the mandatory mitigation for Anthropic's permanent `result`-event regression (issues #1920, #8126, #25629 — all closed-not-planned). A run is considered cleanly complete only when three independent signals all fire: (child process exited) AND (stdout reached EOF) AND (parser queue drained). If 30 seconds elapse from the first signal without all three landing, force the run to a failed state via a 'forced' emission. The detector NEVER trusts the Claude `result` event as a gate-opener — that event may be missing or arrive after the process hangs.

## Implementation Steps

1. Create `main/src/services/streamParser/completionDetector.ts`. Export class `CompletionDetector extends EventEmitter`. Constructor `(runId: string, watchdogMs: number = 30_000, logger?: Logger)`. Private state: three booleans `childExited`, `stdoutEof`, `parserDrained` initialized to `false`; a `disposed` boolean; a `watchdogTimer?: NodeJS.Timeout`; and an `emitted: boolean` flag (guards against double-emission).

2. Implement `signalChildExited(): void`, `signalStdoutEof(): void`, `signalParserDrained(): void`. Each sets its respective flag to `true`, then calls a private `checkComplete()`. The first signal call (any of the three) also starts the watchdog if not already started: `this.watchdogTimer = setTimeout(() => this.fireWatchdog(), this.watchdogMs)`.

3. `checkComplete()` returns early if `this.disposed || this.emitted`. If all three flags are `true`, clear the watchdog timer, set `this.emitted = true`, and emit `'complete'` with payload `{ runId: this.runId, reason: 'all_signals' }`. Log at info level.

4. `fireWatchdog()` returns early if `this.disposed || this.emitted`. Sets `this.emitted = true`, emits `'forced'` with payload `{ runId: this.runId, reason: 'watchdog_timeout', missing: [<list of unset flag names>] }`. Log at warn level — this path is the failure-mitigation path and should be visible in logs for diagnosing hung runs.

5. Implement `dispose(): void`. Set `this.disposed = true`, clear `this.watchdogTimer` if set, and `this.removeAllListeners()`. Dispose is called by the orchestrator when a run is canceled or cleaned up, ensuring the watchdog never fires after the run is gone.

6. Write `main/src/services/streamParser/__tests__/completionDetector.test.ts` using vitest with `vi.useFakeTimers()`. Cover: (a) all three signals → exactly one 'complete' emission; (b) one signal alone → zero emissions, watchdog timer pending; (c) two signals → zero emissions; (d) one signal + 30001ms advance → one 'forced' emission; (e) all three signals after watchdog fired → no second emission; (f) dispose() + three signals → no emission and zero pending timers via `vi.getTimerCount()`.

## Acceptance Criteria

- The 'complete' event payload includes `reason: 'all_signals'` and the 'forced' event payload includes `reason: 'watchdog_timeout'` and a `missing` array naming which of the three flags never fired.
- Watchdog is 30000ms by default but configurable via constructor (so tests can use shorter timeouts if needed, though vitest fake timers make this unnecessary).
- The detector never reads from any `result`-event source. The signal API is closed: `signalChildExited`, `signalStdoutEof`, `signalParserDrained`. There is no `signalResultEvent` method.
- Subsequent integration with `claudeCodeManager.ts` (wired in TASK-205 or a later orchestrator task — NOT this task) connects `ptyProcess.onExit` → `signalChildExited()`, the LineBufferer flush → `signalStdoutEof()`, and an event-queue-empty hook → `signalParserDrained()`. This task only builds the detector; wiring is out of scope.

## Test Strategy

See frontmatter. The detector's logic is purely temporal — vitest's fake timers (`vi.useFakeTimers()`, `vi.advanceTimersByTime()`) make every case deterministic. The mandatory test is the watchdog-fires case: signal one flag, advance 30001ms, assert exactly one 'forced' emission. Without this test, a real-world hung run (the entire point of the detector) is uncovered.

## Hardest Decision

Whether to expose the watchdog timer to the orchestrator (allow extension/early-fire) vs. keep it fully encapsulated. Chose: encapsulated. The 30s value is grounded in IDEA-005's constraint and the architecture research §1 ("30-second watchdog is the only viable approach"). Letting orchestrator code reset or extend the watchdog would invite "just give it a bit more time" bugs that defeat the whole mechanism. The constructor parameter exists strictly for testing.

## Rejected Alternatives

- **Rely on Claude's `result` event as the third gate signal.** Rejected per IDEA-005 constraint and ecosystem research §2 — issues #1920 and #25629 confirm the event is unreliable across multiple Claude versions and Anthropic will not fix it. Using `result` as a gate-opener would silently regress to "runs hang forever" the moment Anthropic ships another version of the bug.
- **Use a shorter watchdog (5s or 10s).** Rejected — Claude can legitimately spend 5–15s on a single tool call's stdout flush before the parser drains. A 30s value is grounded in the architecture research and gives real-world latency enough headroom while still bounding total stall time.
- **Emit a single 'finished' event with a status enum.** Rejected for ergonomic reasons — orchestrator code switches on the event name to drive `workflow_runs.status` transitions ('complete' → completed, 'forced' → failed). Two named events are more legible than one event with a string field.

## Lowest Confidence Area

Whether the "parser queue drained" signal will actually be observable from outside the parser. The current `ClaudeStreamParser` (TASK-201) processes events synchronously inside `.feed()`, so there is no true async queue to "drain" — the parser is drained as soon as `.feed()` returns. The signal becomes meaningful only if a future task introduces async backpressure (e.g., raw_events INSERT batching in TASK-203). For now, the orchestrator wiring task (a downstream task in this epic or a later one) will fire `signalParserDrained()` immediately after the LineBufferer is flushed. This is correct given the synchronous parser design but means the third gate degenerates to "no buffered lines left" in v1. Document this in the wiring task so it isn't misread as a bug.
