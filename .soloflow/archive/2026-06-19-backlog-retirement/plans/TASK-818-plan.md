---
id: TASK-818
idea: IDEA-030
status: ready
created: 2026-06-02T00:00:00Z
source: IDEA-030
epic: interactive-persistent-terminal
files_owned:
  - main/src/services/panels/claude/interactiveClaudeManager.ts
  - main/src/orchestrator/runExecutor.ts
  - main/src/services/substrateDispatchFacade.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/index.ts
  - main/src/services/panels/claude/__tests__/interactiveClaudeManager.completion.test.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/runs.test.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/panels/claude/transcript/transcriptNormalizer.ts
  - main/src/services/cyboflow/transitions.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
acceptance_criteria:
  - criterion: "For persistent interactive runs, handleTurnEnd emits a turn-end EVENT and does NOT write EOF/'/exit'; the REPL stays alive and the per-turn flag is re-armable (each subsequent turn-end re-emits, EOF written only on explicit end). SDK path is unaffected — it has no turn-end-kills-process concept."
    verification: "grep -nE \"persistent|turnEnded|emit\\('turn-end'|EOF_BYTE\" main/src/services/panels/claude/interactiveClaudeManager.ts shows handleTurnEnd (around :593-608) gating the EOF_BYTE+'/exit' writes behind a persistent flag and emitting a turn-end event instead; pnpm --filter main test interactiveClaudeManager.completion asserts NO EOF write on turn-end in persistent mode and that the flag re-arms (a second turn-end re-emits), with EOF written only on explicit end."
  - criterion: "On the turn-end event, RunExecutor calls lifecycleTransitions.restAwaitingReview WITHOUT resolving the spawnCliProcess promise; the spawn promise stays pending across multiple turns (running -> awaiting_review on the event while the spawn promise is unresolved; a second turn re-rests)."
    verification: "grep -nE \"turn-end|restAwaitingReview|onTurnEndEvent|persistent\" main/src/orchestrator/runExecutor.ts shows a NEW event-driven handler that calls restAwaitingReview (the existing transition at runExecutor.ts:489-506) without awaiting/resolving spawnCliProcess; pnpm --filter main test runExecutor asserts running->awaiting_review fires on the event while the spawn promise is still pending, and a second event re-rests."
  - criterion: "SDK path is byte-identical: drained -> awaiting_review is still driven by the query() iterator drain (spawnCliProcess resolution); the new event-driven rest path is gated OFF for sdk (a non-persistent run never takes the event path)."
    verification: "pnpm --filter main test runExecutor asserts an sdk run resolves its spawn promise at iterator drain -> 'drained' -> restAwaitingReview with NO event-driven rest; grep -nE \"substrate|persistent\" main/src/orchestrator/runExecutor.ts shows the event handler is guarded so sdk runs never enter it."
  - criterion: "Explicit End-session / Merge / Dismiss (and/or killProcess/stopPanel) is the ONLY path that writes EOF+'/exit' -> wireCompletionExit.onExit (interactiveClaudeManager.ts:618-633) resolves the spawn promise; teardownRun does NOT dispose the bridge/pipeline mid-REPL (teardown deferred to explicit termination for interactive)."
    verification: "grep -nE \"endSession|killProcess|EOF_BYTE|teardownRun|persistent\" main/src/services/panels/claude/interactiveClaudeManager.ts main/src/orchestrator/runExecutor.ts main/src/orchestrator/trpc/routers/runs.ts shows an explicit-termination seam writing the now-conditional EOF path and teardownRun (runExecutor.ts:283 finally) NOT firing while the interactive REPL is alive; pnpm --filter main test runs.test AND interactiveClaudeManager.completion assert the spawn promise resolves ONLY on explicit termination and that the bridge teardown is deferred."
  - criterion: "InteractiveClaudeManager exposes a public resizePanel(panelId, cols, rows): void that looks up the live node-pty via the existing per-panel process map and calls cliProcess.process.resize(cols, rows), and is a no-op when no live process exists for the panelId. This delivers TASK-817's deferred manager-side resize so SubstrateDispatchFacade.relayResize (which feature-detects this method) is functional rather than a permanent no-op. The SDK manager gets no such method (no PTY)."
    verification: "grep -nE \"resizePanel|\\.resize\\(\" main/src/services/panels/claude/interactiveClaudeManager.ts shows the resizePanel method calling process.resize(cols, rows) via the per-panel process map; pnpm --filter main test interactiveClaudeManager.completion asserts a fake IPty receives resize(cols, rows) after resizePanel and that resizePanel no-ops (no throw, no resize call) when the panel has no live process."
  - criterion: "recoverStaleAwaitingReview does not fail a persistent live interactive run on boot — a distinct live-state guard skips boot recovery for persistent runs (approvalRouter.ts:493-524 is READONLY; the guard lives in the persistent run's state, not in a rewrite of the recovery sweep)."
    verification: "a test (runExecutor.test or runs.test) asserts a persistent live/awaiting-input interactive run is NOT transitioned to 'failed' by the boot-recovery path; grep -nE \"recoverStaleAwaitingReview|persistent|live\" main/src/orchestrator/__tests__/runExecutor.test.ts main/src/orchestrator/trpc/routers/__tests__/runs.test.ts returns >=1 match documenting the live-state skip."
  - criterion: "No `any` in any file this task owns; optional logger? is PASSED to every observability constructor touched (never omitted)."
    verification: "grep -nE \":\\s*any(\\b|\\[)|<any>|as any\" main/src/services/panels/claude/interactiveClaudeManager.ts main/src/orchestrator/runExecutor.ts main/src/services/substrateDispatchFacade.ts main/src/orchestrator/trpc/routers/runs.ts main/src/index.ts main/src/services/panels/claude/__tests__/interactiveClaudeManager.completion.test.ts main/src/orchestrator/__tests__/runExecutor.test.ts main/src/orchestrator/trpc/routers/__tests__/runs.test.ts returns 0 matches; pnpm lint exits 0."
  - criterion: "Q3 panel-preservation: the structured Workflow panel + the SDK substrate stay byte-identical. This task adds NO change to the cyboflow:stream envelope, the runEventBridge, or the SDK manager; the only new behavior is gated behind the interactive/persistent flag."
    verification: "git diff --stat shows 0 changed lines on main/src/services/panels/claude/claudeCodeManager.ts and main/src/orchestrator/runEventBridge.ts; grep -nE \"persistent|substrate === 'interactive'|isInteractive\" main/src/orchestrator/runExecutor.ts confirms every new branch is gated so sdk runs take the unchanged drained-at-spawn-resolution path."
  - criterion: "pnpm test:unit exits 0 (one-shot vitest run; never test:e2e), including interactiveClaudeManager.completion.test.ts, runExecutor.test.ts, and runs.test.ts."
    verification: "Run pnpm test:unit; exit code 0. If a better-sqlite3 NODE_MODULE_VERSION error appears, run pnpm rebuild better-sqlite3 first (CLAUDE.md), then re-run."
  - criterion: "The touched code type-checks and lints clean."
    verification: "pnpm typecheck && pnpm lint exit 0"
depends_on: [TASK-817]
estimated_complexity: high
test_strategy:
  needed: true
  justification: "This slice reworks the central completion coupling — RunExecutor today equates spawnCliProcess-promise-resolution with run-done, and TASK-808's first-turn EOF/'/exit' kill is the ONLY thing breaking interactive persistence. Getting it wrong has two failure modes that MUST be locked by tests: (a) the run sits in 'running' forever (no awaiting_review, no Merge/Dismiss close-out, UI hangs) if the new event-driven rest is mis-wired, or (b) the spawn promise resolves early and teardownRun disposes the bridge while the REPL is alive (orphaned live PTY). The SDK-path byte-identity (event path gated off for sdk) and the boot-recovery live-state skip are likewise correctness invariants, not cosmetics. Three sibling test files already exist (interactiveClaudeManager.completion.test.ts with a faked-PTY + fake-TranscriptSource harness, runExecutor.test.ts, runs.test.ts) and are extended additively here."
  targets:
    - behavior: "In persistent mode, handleTurnEnd emits a turn-end event and does NOT write EOF/'/exit'; the per-turn flag re-arms across turns; EOF is written only on explicit end-session/killProcess."
      test_file: "main/src/services/panels/claude/__tests__/interactiveClaudeManager.completion.test.ts"
      type: unit
    - behavior: "The turn-end event drives running -> awaiting_review via restAwaitingReview while the spawnCliProcess promise stays pending across multiple turns; a non-persistent (sdk) run resolves spawn at iterator drain and takes no event-driven rest."
      test_file: "main/src/orchestrator/__tests__/runExecutor.test.ts"
      type: unit
    - behavior: "teardownRun does not dispose the bridge/pipeline while the interactive REPL is alive; teardown is deferred to explicit termination."
      test_file: "main/src/orchestrator/__tests__/runExecutor.test.ts"
      type: unit
    - behavior: "Explicit End-session / Merge / Dismiss writes the now-conditional EOF -> wireCompletionExit resolves the spawn promise; that is the only path to terminal for a persistent interactive run."
      test_file: "main/src/orchestrator/trpc/routers/__tests__/runs.test.ts"
      type: unit
    - behavior: "resizePanel(panelId, cols, rows) calls resize(cols, rows) on the live IPty for that panel and no-ops when no live process exists (delivers TASK-817's deferred manager resize seam)."
      test_file: "main/src/services/panels/claude/__tests__/interactiveClaudeManager.completion.test.ts"
      type: unit
    - behavior: "A persistent live/awaiting-input interactive run is NOT failed by the boot-recovery sweep (live-state guard skips it)."
      test_file: "main/src/orchestrator/trpc/routers/__tests__/runs.test.ts"
      type: unit
---

# Persistence/completion rework: gate turn-end kill, event-driven rest, explicit-termination resolver

## Objective

Make the interactive CLI substrate (`substrate==='interactive'`) a TRUE persistent multi-turn session: it must NOT die after each turn or at an approval gate. Today the run lifecycle equates `spawnCliProcess`-promise-resolution with "run done" (`runExecutor.ts:257-269`; `restAwaitingReview` guarded on `status='running'` at `:489-506`), and TASK-808's `InteractiveClaudeManager.handleTurnEnd` (`interactiveClaudeManager.ts:593-608`) writes `EOF_BYTE`+`/exit` on the FIRST turn-end — which is the ONLY thing breaking persistence (turn-end fires at the end of EVERY assistant turn via `transcriptNormalizer` `stop_hook_summary`/`turn_duration`, including every in-session human checkpoint, so the REPL dies at the first checkpoint).

The rework (4 coupled parts, all gated behind a substrate/persistent flag so the SDK path is byte-identical):

1. **Gate the kill** — in `handleTurnEnd`, when the run is persistent, do NOT write `EOF_BYTE`+`/exit`; instead emit a NEW turn-end EVENT and leave the REPL alive. Make `run.turnEnded` per-turn re-armable (not one-shot).
2. **Event-driven rest** — route the turn-end event (already surfaced via `onTurnEnd` at `:481-485`) through the `SubstrateDispatchFacade` EventEmitter to a NEW `RunExecutor` handler that calls `lifecycleTransitions.restAwaitingReview` WITHOUT resolving the spawn promise (promise stays pending across turns; safely no-ops if a gate is already open because `restAwaitingReview` is guarded on `status='running'`).
3. **Explicit termination = the only spawn-promise resolver** — wire End-session / Merge / Dismiss (`runs.ts`) and/or `stopPanel`/`killProcess` to write the now-conditional `EOF`+`/exit` so `wireCompletionExit.onExit` (`:618-633`) fires its existing resolve/reject. Defer `teardownRun` (the `runExecutor.ts:283` finally) so it does NOT dispose the bridge while the REPL is alive.
4. **SDK path UNTOUCHED** — SDK drains via the `query()` iterator; the new event path is gated OFF for sdk. Plus address the `recoverStaleAwaitingReview` risk (`approvalRouter.ts:493-524`, READONLY): a persistent live run must not be killed on boot — add a distinct live-state guard so boot recovery skips it.

NEVER reuse the turn-end marker as the terminal/drained proxy — it fires every turn. All four shared backend files (`interactiveClaudeManager.ts`, `substrateDispatchFacade.ts`, `runExecutor.ts`, `runs.ts`, `index.ts`) are edited ADDITIVELY on top of TASK-814/815/816/817's already-committed wiring — do NOT remove prior tasks' additions (the `pty-output` emit, the facade fan-in + `relayInput`/`relayResize`, the `ptyPublisher`, the `setCancelAndRestartDeps`/relay dep-bag).

## Implementation Steps

1. **Add a persistent flag to the interactive run record.** In `interactiveClaudeManager.ts`, extend the `InteractiveRun` interface (`:122-133`) with a `persistent: boolean` field (default derived from the run's substrate being `'interactive'` — every run this manager spawns IS interactive, so set `persistent: true` in the `interactiveRun` literal at `:430-438`). Change the `turnEnded` field's contract from "EOF written once" to a per-turn re-armable boolean: add a `private readonly liveRuns = new Set<string>()` (panelIds whose REPL is intentionally kept alive) or reuse `persistent` + reset `turnEnded` after each emit. Keep the existing `resolve`/`reject` deferred semantics (`:423-428`) intact — those still settle the spawn promise on the FINAL explicit exit.

2. **Gate the kill in `handleTurnEnd` (`:593-608`).** Currently it sets `run.turnEnded = true` (one-shot guard) then writes `cliProcess.process.write(EOF_BYTE)` + `write('/exit\n')` (`:603-604`). Rework:
   - If `run.persistent`: do NOT write `EOF_BYTE`/`/exit`. Emit a NEW typed event — `this.emit('turn-end', { panelId, sessionId: run.sessionId, runId: run.runId })` — and re-arm by leaving the REPL alive (reset any per-turn guard so the NEXT `stop_hook_summary` re-emits). Log via `this.logger?.verbose(...)` (optional-logger rule — PASS the logger).
   - If NOT persistent (defensive / future non-interactive use): keep the existing `EOF_BYTE`+`/exit` write so the legacy single-turn behavior is preserved.
   - Extract the EOF-write into a `private writeExitToRepl(panelId)` helper so the explicit-termination path (step 6) can call the SAME conditional write.

3. **Surface the turn-end event through the facade.** In `substrateDispatchFacade.ts`, add an `interactiveTurnEndHandler: ForwardHandler` field (mirror the existing `interactiveOutputHandler`/`interactiveExitHandler` at `:60-61`/`:76-77`/`:81-82`). In the constructor, subscribe `this.interactiveManager.on('turn-end', this.interactiveTurnEndHandler)` re-emitting `this.emit('turn-end', payload)` by reference (same pattern as the output fan-in at `:74-82`). In `dispose()` (`:146-154`), add `this.interactiveManager.off('turn-end', this.interactiveTurnEndHandler)`. The SDK manager is NOT subscribed to `'turn-end'` — SDK never emits it, so the SDK path is structurally untouched. Do NOT remove TASK-814's output fan-in or TASK-817's `relayInput`/`relayResize` additions.

4. **Add the event-driven rest handler to `RunExecutor`.** In `runExecutor.ts`, the `source` EventEmitter is the facade. Today `bridgeEvents()` registers `'output'`/`'exit'` listeners; add a `'turn-end'` listener registered for interactive runs only. On the event:
   - Call `await this.onLifecycleTransition(runId, 'drained')` — which already maps to `lifecycleTransitions.restAwaitingReview(runId)` (`:489-506`) — WITHOUT touching the spawn promise. Because `restAwaitingReview` is guarded on `status='running'` (so it no-ops/rejects-then-swallows when an approval/question gate is already open), this is safe per-turn and re-entrant.
   - Do NOT call `this.emitStep(runId, 'done')` here (that is reserved for terminal); the run rests in `awaiting_review` between turns but is NOT done.
   - Gate this handler so it only fires for interactive/persistent runs (resolve `run.substrate` via `this.registry.getRunById(runId)`; sdk runs ignore the event — they never receive one anyway). The existing `await this.spawnCliProcess(...)` at `:256-264` STAYS pending across turns for interactive runs; for sdk it still resolves at iterator drain -> the unchanged `'drained'` path at `:269`.

5. **Defer `teardownRun` for live interactive runs.** The `execute()` `finally` block calls `this.teardownRun(runId)` at `:282-284`. For a persistent interactive run the spawn promise stays pending, so `execute()` does NOT return until the explicit-termination exit — meaning `teardownRun` naturally does NOT run mid-REPL (the `finally` only fires after `await spawnCliProcess` settles on the final exit). VERIFY this holds (the await at `:257` blocks the `finally`); if any early-return path could fire the finally while the REPL is alive, guard `teardownRun` so it skips bridge/pipeline disposal while `liveRuns` still contains the panelId. The manager-side `teardownRun` (`interactiveClaudeManager.ts:670-707`) must likewise NOT stop the `TranscriptSource` / dispose the pipeline until explicit termination — confirm it is only called from `killProcess`/`cancel`, not from a turn-end path.

6. **Wire explicit termination as the only spawn-promise resolver.** Two seams, both ADDITIVE:
   - **Manager:** add a `public async endSession(panelId: string): Promise<void>` that calls the `writeExitToRepl(panelId)` helper (step 2) — writing the now-conditional `EOF_BYTE`+`/exit` — so `wireCompletionExit.onExit` (`:618-633`) fires its existing `run.resolve()` (clean exit) / `run.reject()` (non-zero), settling the spawn promise. `stopPanel`/`killProcess` (`:767-769`) remain the hard-kill path (already resolves via the inherited onExit).
   - **Router:** in `runs.ts`, the `merge` (`:319-370`), `createPr` (`:388-419`), and `dismiss` (`:427-453`) close-out mutations must, for interactive runs, call the new manager `endSession` seam BEFORE the worktree-removal + guarded `UPDATE workflow_runs SET status=...` so the live REPL is terminated and its spawn promise resolved as part of close-out. Inject the manager handle by EXTENDING TASK-817's existing relay dep-bag — DO NOT split `endSession` across two bags. TASK-817 declared `interface RelayDeps { relayInput(runId, text): void; relayResize(runId, cols, rows): void }` wired by `setRelayDeps`; extend it to `interface RelayDeps { relayInput(runId, text): void; relayResize(runId, cols, rows): void; endSession(runId): Promise<void> }` and re-call `setRelayDeps` in `index.ts` to include the `endSession` ref. The close-out mutations read `relayDeps.endSession(runId)`. Do NOT route `endSession` through `runCloseoutDeps`/`setCancelAndRestartDeps` — `RelayDeps` is the single bag for live-session collaborators (relay + end-session), which keeps the interactive-session seams in one place. Wire the extended `setRelayDeps` call in `index.ts` near the facade/RunExecutor construction (`~:643-722`), alongside TASK-817's relay wiring.

7. **Add the PTY resize seam on `InteractiveClaudeManager` (delivers TASK-817's deferred `relayResize`).** TASK-817 shipped `SubstrateDispatchFacade.relayResize` + the renderer `ResizeObserver`, but feature-detects a manager `resizePanel` method that does not yet exist — so resize is a permanent no-op until this seam lands (TASK-817 explicitly deferred it to "TASK-818, which owns interactiveClaudeManager.ts"). Add a public method to `InteractiveClaudeManager`:
   ```
   public resizePanel(panelId: string, cols: number, rows: number): void {
     const cliProcess = this.processes.get(panelId);  // the existing per-panel process map
     if (!cliProcess?.process) return;                 // no live PTY → no-op
     cliProcess.process.resize(cols, rows);             // node-pty IPty.resize (pty.IPty, AbstractCliManager.ts:12-13)
   }
   ```
   Look up the live node-pty via the EXISTING per-panel process map the manager already owns (the `processes` map keyed by panelId — the same map `cliProcess.process.write` uses in `sendInput`); do NOT add a new map. `cliProcess.process` is typed `pty.IPty`, which exposes `resize(cols, rows)` (the same call `terminalSessionManager.resizeTerminal` uses, terminalSessionManager.ts:98-101). This is the method TASK-817's facade feature-detects via its narrow `ResizeCapable` interface, so once it exists the facade relay → renderer ResizeObserver chain is functional end-to-end. No `any`. The SDK manager gets NO such method (SDK has no PTY) — Q3/SDK byte-identity holds.

8. **Add the boot-recovery live-state guard.** `recoverStaleAwaitingReview` (`approvalRouter.ts:493-524`) is READONLY — it fails `awaiting_review` runs that still have a `pending` approval on boot. A persistent live interactive run that rests in `awaiting_review` between turns must NOT be killed on boot. Since the approvalRouter file is readonly, the guard must come from the run's STATE: a persistent live run that survives a process restart is no longer truly "live" (the PTY died with the process), so the correct behavior is that a persistent run, once the app restarts, IS stale and the existing recovery is correct for it. Confirm via a test (step 11) that the IN-PROCESS lifecycle never lets `recoverStaleAwaitingReview` fire against a still-running persistent run during a single session (boot recovery runs once at startup, before any persistent run exists). If a distinct non-terminal live state is needed to disambiguate "turn-end rest" from "approval-gate awaiting_review", document it as the follow-up but do NOT introduce a new DB status in this task (out of scope — see below); the minimal guard is that boot recovery only runs at startup and a within-session persistent run is never subject to it.

9. **Extend `interactiveClaudeManager.completion.test.ts`** (existing harness: faked `FakePty` + fake `TranscriptSource`, `:1-40`). Add cases:
   - Persistent run: fire `onTurnEnd` -> assert NO `EOF_BYTE`/`/exit` write to the fake PTY, and assert a `'turn-end'` event is emitted with `{ panelId, sessionId, runId }`.
   - Re-arm: fire a SECOND `onTurnEnd` -> assert it ALSO emits (per-turn re-armable, not one-shot) and still no EOF.
   - Explicit end: call `endSession(panelId)` (or `killProcess`) -> assert `EOF_BYTE`+`/exit` IS written, then PTY `onExit(0)` -> spawn promise resolves after the settle window. Keep the existing TASK-808 non-persistent cases intact.
   - Resize seam: call `resizePanel(panelId, cols, rows)` on a spawned run -> assert the fake `IPty` receives `resize(cols, rows)`; assert `resizePanel` is a no-op (no throw, no `resize` call) when no live process exists for the panelId.

10. **Extend `runExecutor.test.ts`.** Add: a persistent/interactive run where a `'turn-end'` event on the source drives `running -> awaiting_review` (assert `restAwaitingReview` called) while the `spawnCliProcess` promise is still PENDING; a second event re-rests; and a contrasting SDK run where the spawn promise resolves at iterator drain -> `'drained'` with NO event-driven rest (event path gated off). Assert `teardownRun` does NOT fire (bridge not disposed) until the spawn promise resolves on explicit termination.

11. **Extend `runs.test.ts`.** Add: `merge`/`dismiss` on an interactive run calls the `endSession`/abort seam (writes EOF) so the spawn promise resolves and the guarded `UPDATE` marks the run terminal — assert the spawn promise resolves ONLY on this explicit path; and a boot-recovery case asserting a persistent live run within a session is not failed by `recoverStaleAwaitingReview` (the live-state skip).

12. **Run the gates.** No-`any` grep over all owned files; `pnpm lint`; `pnpm test:unit` (exit 0). If a `better-sqlite3` `NODE_MODULE_VERSION` error appears, run `pnpm rebuild better-sqlite3` first (CLAUDE.md). Confirm `git diff --stat` shows 0 changed lines on `claudeCodeManager.ts` and `runEventBridge.ts` (Q3 + SDK byte-identity).

## Acceptance Criteria notes

- **The completion coupling is THE load-bearing risk.** RunExecutor structurally equates `spawnCliProcess`-resolution with "turn/run done -> drained -> awaiting_review" (`runExecutor.ts:257-269`). Two failure modes the tests must lock: (a) if the new event-driven rest is mis-wired the run sits in `running` forever (no `awaiting_review`, no Merge/Dismiss, UI hangs); (b) if the spawn promise resolves early, `teardownRun` (`:283` finally) disposes the bridge/pipeline while the REPL is alive — orphaning the live PTY. Both are asserted in `runExecutor.test.ts`.
- **NEVER reuse the turn-end marker as the terminal/drained proxy** — it fires on EVERY assistant turn boundary (`transcriptNormalizer` `stop_hook_summary`/`turn_duration`), including every in-session AskUserQuestion checkpoint. It maps to "rest awaiting next input", never to "flow complete". The only terminal signal is the explicit `EOF`+`/exit` from End-session / Merge / Dismiss / killProcess.
- **SDK byte-identity is gated, not incidental.** Every new branch (the `'turn-end'` listener, the deferred teardown, the conditional EOF) is gated behind `run.substrate==='interactive'` / `persistent`. An SDK run receives no `'turn-end'` event (the facade only subscribes the interactive manager), resolves its spawn promise at `query()` iterator drain, and takes the unchanged `'drained'` path at `runExecutor.ts:269`. The Q3 panel + SDK manager + `runEventBridge` show 0 diff.
- **`restAwaitingReview` is already gate-safe.** It is guarded on `status='running'` (`runExecutor.ts:489-506`), so firing it on a turn-end while an approval/question gate is open is a swallowed no-op — the open gate's own cycle (`transitionFromAwaitingReview`) drives the run. This is why the event-driven rest is safe to fire per-turn without coordinating with the approval router.
- **Boot-recovery is READONLY** (`approvalRouter.ts:493-524`). The guard is that a persistent run is only "live" within one process; after a restart the PTY is dead and the existing recovery is correct. A new distinct DB status to disambiguate turn-end-rest from approval-gate-awaiting_review is a follow-up, not this task.
- **All four backend files are edited ADDITIVELY** on top of TASK-814..817's committed wiring. Do NOT remove the `pty-output` emit (814), the facade fan-in / `relayInput` / `relayResize` (814/817), the `ptyPublisher` (814), or the relay dep-bag (817). This task adds the `'turn-end'` event + handler, the `endSession` seam, and the close-out wiring alongside them.

## Out of Scope

- The raw-PTY rendering pipeline (`pty-output` emit, facade fan-in, `ptyPublisher`, `cyboflow:pty:` channel, preload allowlist) — owned by TASK-814; consumed here, not re-implemented.
- The `InteractiveTerminalView`, `RunChatView` transcript swap, interactive chrome, and `InteractiveWarnDialog` — owned by TASK-815/816 (frontend).
- The `sendTurn` live-input path (`relayInput`/`relayResize` backend FACADE relay, the `runs` relay mutations, the composer relay, keystroke relay, the renderer `ResizeObserver`) — owned by TASK-817; consumed here. EXCEPTION: the manager-side `resizePanel` seam that TASK-817's `relayResize` feature-detects is OWNED by this task (step 7) — TASK-817 deferred it here, and without it resize is a permanent no-op. The `endSession` close-out seam EXTENDS TASK-817's `RelayDeps` bag to `{ relayInput, relayResize, endSession }` via a re-called `setRelayDeps`, NOT a new or competing bag and NOT `runCloseoutDeps`.
- The interactive approval-gate wiring (`InteractiveSettingsWriter.write` on spawn, `denyInFlightShellApprovals`/`removeGeneratedSettings` teardown bodies) — owned by TASK-819 (IT-7); the no-op stubs at `interactiveClaudeManager.ts:714-724` stay as-is in this task.
- Introducing a NEW DB run status (e.g. `awaiting_input`/`idle-live`) to disambiguate turn-end-rest from approval-gate `awaiting_review` — deferred; this task rests in the existing `awaiting_review` and documents the disambiguation as a follow-up.
- Dynamic-workflow-def-driven prompts and real per-stage `current_step_id` advancement (mapping transcript step-report markers back into `stepTransitionBridge` during the run) — explicitly DEFERRED to a separate iteration (NOT in IDEA-030); step tracking stays observational and main-session-only.
- Any change to the SDK substrate (`claudeCodeManager.ts`), the structured Workflow panel, the `cyboflow:stream` envelope, or `runEventBridge.ts` — must stay byte-identical (Q3 + SDK-untouched invariant).
- A `pnpm test:e2e` gate — per CLAUDE.md the verifier AC gate is `pnpm test:unit` only (Playwright cannot bootstrap without the Electron preload).
