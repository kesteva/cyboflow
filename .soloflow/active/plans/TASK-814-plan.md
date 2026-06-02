---
id: TASK-814
idea: IDEA-030
status: ready
created: 2026-06-02T00:00:00Z
source: IDEA-030
epic: interactive-persistent-terminal
files_owned:
  - main/src/services/panels/claude/interactiveClaudeManager.ts
  - main/src/services/substrateDispatchFacade.ts
  - main/src/index.ts
  - main/src/preload.ts
  - main/src/services/panels/claude/__tests__/interactiveClaudeManager.test.ts
  - main/src/services/__tests__/substrateDispatchFacade.test.ts
files_readonly:
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - shared/types/claudeStream.ts
acceptance_criteria:
  - criterion: "When the interactive PTY emits data, InteractiveClaudeManager emits a NEW 'pty-output' event carrying the VERBATIM chunk (no line-split, no \\n re-join) plus the per-run identity fields { panelId, sessionId, runId, type:'pty', data, timestamp }. The emit is a SECOND, additive ptyProcess.onData listener registered AFTER setupProcessHandlers in spawnCliProcess (the same multi-listener precedent as wireCompletionExit's extra onExit at interactiveClaudeManager.ts:455/618), never inside the base setupProcessHandlers."
    verification: "grep -n \"pty-output\" main/src/services/panels/claude/interactiveClaudeManager.ts shows one emit('pty-output', …) inside spawnCliProcess after the setupProcessHandlers call (~454); grep -n \"ptyProcess.onData\" main/src/services/panels/claude/interactiveClaudeManager.ts shows the new additive listener. pnpm --filter main test interactiveClaudeManager — drive a fake ptyProcess.onData with a multi-line ANSI chunk and assert exactly ONE pty-output per onData call with data byte-equal to the chunk (no split)."
  - criterion: "The base 'output'/type:'json' path is unchanged: parseCliOutput still returns [] and no pty-output rides the 'output' channel. The structured transcript-tail emit('output', type:'json') and the SDK path stay byte-identical (Q3 panel-preservation)."
    verification: "grep -nA2 \"protected parseCliOutput\" main/src/services/panels/claude/interactiveClaudeManager.ts shows the body still `return [];` (~330-332). pnpm --filter main test interactiveClaudeManager — assert the emit('output') call count is unchanged when a raw PTY chunk arrives (only the session_info + transcript-tail json emits fire; the raw chunk produces a pty-output, never an output)."
  - criterion: "SubstrateDispatchFacade re-emits 'pty-output' by reference from the interactive manager ONLY (mirror of interactiveOutputHandler at substrateDispatchFacade.ts:76/81), and off()s it in dispose() (mirror of substrateDispatchFacade.ts:149). The SDK manager is NEVER subscribed to pty-output."
    verification: "grep -n \"pty-output\" main/src/services/substrateDispatchFacade.ts shows the interactiveManager.on('pty-output', …) subscription and the dispose off(); grep -n \"sdkManager.on('pty-output'\\|sdkManager.on(\\\"pty-output\\\"\" main/src/services/substrateDispatchFacade.ts returns 0. pnpm --filter main test substrateDispatchFacade — assert pty-output emitted by the interactive manager is forwarded on the facade, that sdkManager.emit('pty-output', …) is NOT forwarded, and that after dispose() the interactive pty-output is no longer forwarded."
  - criterion: "index.ts adds a ptyPublisher that does win.webContents.send('cyboflow:pty:'+runId, { runId, data, timestamp }) (mirror of cyboflowPublisher at index.ts:559-565) and subscribes the facade's 'pty-output' event to it, wired where the facade + mainWindow are in scope near the RunExecutor construction (~712). The raw bytes bypass runEventBridge entirely (no raw_events persistence)."
    verification: "grep -n \"cyboflow:pty:\" main/src/index.ts shows the webContents.send to the cyboflow:pty:<runId> channel; grep -n \"substrateFacade.on('pty-output'\\|facade.on('pty-output'\" main/src/index.ts shows the facade subscription wired near the RunExecutor ctor; grep -n \"pty-output\" main/src/orchestrator/runEventBridge.ts returns 0 (raw bytes never enter the bridge)."
  - criterion: "preload.ts allows channel.startsWith('cyboflow:pty:') in BOTH the on() allowlist (~625) and the off() allowlist (~638), mirroring the existing cyboflow:stream: prefix gate, so the renderer subscription is not silently dropped."
    verification: "grep -n \"cyboflow:pty:\" main/src/preload.ts shows exactly two startsWith hits — one in the on() guard (~625) and one in the off() guard (~638)."
  - criterion: "No `any` type is introduced in any owned file, and any optional logger? on a touched class is PASSED, not omitted (CLAUDE.md silent-no-op rule)."
    verification: "grep -nE ':\\s*any(\\b|\\[)|<any>|as any' main/src/services/panels/claude/interactiveClaudeManager.ts main/src/services/substrateDispatchFacade.ts main/src/index.ts main/src/preload.ts main/src/services/panels/claude/__tests__/interactiveClaudeManager.test.ts main/src/services/__tests__/substrateDispatchFacade.test.ts returns 0 matches."
  - criterion: "The full unit gate is green and the code type-checks and lints clean."
    verification: "pnpm typecheck && pnpm lint exit 0; pnpm test:unit exits 0 (one-shot vitest run; NOT test:e2e) with interactiveClaudeManager.test.ts and substrateDispatchFacade.test.ts included. If a better-sqlite3 NODE_MODULE_VERSION error appears, run `pnpm rebuild better-sqlite3` first per CLAUDE.md."
depends_on: [TASK-813]
estimated_complexity: M
test_strategy:
  needed: true
  justification: "This task stands up a brand-new additive backend transport (the raw-PTY byte path) whose correctness rests on three claims that must be locked by tests, not just inspected: (1) the new listener forwards the VERBATIM chunk with no line-split — a regression here silently corrupts xterm ANSI cursor sequences downstream; (2) the base 'output'/type:'json' structured path and SDK path stay byte-identical (Q3 panel-preservation) — the raw bytes must NOT ride 'output' or reach runEventBridge; (3) the facade forwards pty-output for the interactive manager ONLY and removes the listener on dispose, never wiring the SDK manager. The two named sibling suites (interactiveClaudeManager.test.ts with its fake-PTY harness, substrateDispatchFacade.test.ts with its two-manager fan-in harness) already exist and anchor these new cases. The preload allowlist + publisher wiring are verified by grep ACs + the lint/typecheck/test:unit gate."
  targets:
    - behavior: "InteractiveClaudeManager emits exactly one 'pty-output' per ptyProcess.onData chunk with data byte-equal to the chunk (no line-split) and the full { panelId, sessionId, runId, type:'pty', timestamp } identity; the base emit('output') count and parseCliOutput()=[] are unchanged."
      test_file: "main/src/services/panels/claude/__tests__/interactiveClaudeManager.test.ts"
      type: unit
    - behavior: "SubstrateDispatchFacade re-emits the interactive manager's 'pty-output' by reference, never forwards the SDK manager's pty-output, and removes the interactive listener on dispose()."
      test_file: "main/src/services/__tests__/substrateDispatchFacade.test.ts"
      type: unit
---

# Raw-PTY backend pipeline: pty-output emit -> facade fan-in -> ptyPublisher -> cyboflow:pty channel -> preload allowlist

## Objective

Stand up the additive, interactive-only raw-byte path that carries the live `claude --resume` PTY ANSI stream to the renderer for a future live xterm.js terminal (rendered by TASK-815), WITHOUT any parse/normalize and WITHOUT coupling to `cyboflow:stream`. The path is end-to-end in this task on the backend only: a new `'pty-output'` event emitted from a SECOND `ptyProcess.onData` listener in `InteractiveClaudeManager.spawnCliProcess` → a `pty-output` fan-in re-emit on `SubstrateDispatchFacade` → a new `ptyPublisher` in `index.ts` that sends on a dedicated `cyboflow:pty:<runId>` channel → a `startsWith('cyboflow:pty:')` allow in `preload.ts` on/off. The structured Workflow panel path (the transcript-tail `emit('output', type:'json')`) and the SDK `ClaudeCodeManager` path stay BYTE-IDENTICAL (Q3 panel-preservation): raw bytes never ride the `'output'` channel and never enter `runEventBridge` (its `type!=='json'` filter at runEventBridge.ts:207 drops them by construction — but they never even reach it because they travel on a distinct event + channel and are never persisted to `raw_events`). The SDK manager is NEVER subscribed to `pty-output` — the SDK substrate has no PTY (`ClaudeCodeManager` stores `process: undefined as never`), so the path is interactive-only by construction. This task adds NO renderer code (the `subscribeToPtyBytes` wrapper + xterm view are TASK-815) and NO live-input/resize relay (TASK-817) and NO completion-model change (TASK-818) — those land in later, dependency-ordered slices that edit the same shared files ADDITIVELY.

## Implementation Steps

1. **Emit a NEW `'pty-output'` event from a SECOND, additive `ptyProcess.onData` listener in `InteractiveClaudeManager.spawnCliProcess`.** In `main/src/services/panels/claude/interactiveClaudeManager.ts`, AFTER the existing `this.setupProcessHandlers(ptyProcess, panelId, sessionId)` call at interactiveClaudeManager.ts:454 (and alongside the `this.wireCompletionExit(ptyProcess, interactiveRun)` at :455, which is the exact precedent for registering an EXTRA node-pty listener additively), register a second listener:
   `ptyProcess.onData((data: string) => this.emit('pty-output', { panelId, sessionId, runId, type: 'pty', data, timestamp: new Date() }));`
   - `runId` is already in scope here — resolved at interactiveClaudeManager.ts:382 (`sessionRow?.run_id ?? options.runId ?? panelId`) and stored on the `InteractiveRun` record at :433.
   - Emit the WHOLE chunk VERBATIM — do NOT line-split, do NOT re-append `\n`. The base `setupProcessHandlers.onData` (AbstractCliManager.ts:660-677, READ-ONLY) splits on `\n` and re-joins for the structured `parseCliOutput` per-line path; reusing that would mangle ANSI cursor/control sequences and break xterm rendering. The raw listener forwards `data` unmodified.
   - node-pty's `onData` is multi-listener: this second registration does NOT disturb the inherited `setupProcessHandlers` onData. This is the SINGLE additive change in the manager body for this task.
   - Pass the existing `this.logger?` only where you add a diagnostic (optional-logger rule); do not omit it. No `any` — annotate `data: string` and the payload object fields explicitly.

2. **Leave the base `'output'`/`type:'json'` path byte-identical (Q3).** Do NOT touch `parseCliOutput` (interactiveClaudeManager.ts:330-332 still `return [];`), do NOT touch the `setupProcessHandlers` call, the `session_info` `emit('output', …)` at :405, or the transcript-tail `onLine` `emit('output', { type:'json', … })` at :472. The raw bytes ride the NEW `'pty-output'` event ONLY — they must never appear on the `'output'` channel (where `runEventBridge` would see them and its `type!=='json'` filter would drop them anyway, but routing them there at all risks the structured invariant). This is the load-bearing additive-isolation guarantee.

3. **Add the `pty-output` fan-in to `SubstrateDispatchFacade` (interactive manager ONLY).** In `main/src/services/substrateDispatchFacade.ts`, mirror the existing `interactiveOutputHandler` fan-in:
   - Add a stored bound handler field `private readonly interactivePtyHandler: ForwardHandler;` alongside the four existing handler fields (substrateDispatchFacade.ts:58-61).
   - In the constructor, after the existing `this.interactiveOutputHandler = (payload) => this.emit('output', payload);` (substrateDispatchFacade.ts:76), add `this.interactivePtyHandler = (payload) => this.emit('pty-output', payload);` and subscribe it: `this.interactiveManager.on('pty-output', this.interactivePtyHandler);` (mirror :81). Re-emit by reference — never reshape the payload.
   - Do NOT subscribe `this.sdkManager` to `'pty-output'` (the SDK manager never emits it; the path is interactive-only).
   - In `dispose()`, off() it: `this.interactiveManager.off('pty-output', this.interactivePtyHandler);` alongside the existing `off()`s at substrateDispatchFacade.ts:147-150.

4. **Add the `ptyPublisher` + facade subscription in `index.ts`.** In `main/src/index.ts`, mirror the `cyboflowPublisher` at index.ts:559-565:
   - Define a publisher closure that sends on the dedicated channel:
     `const ptyPublisher = (runId: string, data: string, timestamp: Date | string) => { const win = mainWindow; if (!win || win.isDestroyed()) return; win.webContents.send('cyboflow:pty:' + runId, { runId, data, timestamp }); };`
   - Wire the facade subscription where the facade (`substrateFacade`, constructed at index.ts:643-648) AND `mainWindow` are in scope — near the RunExecutor construction at index.ts:712-722:
     `substrateFacade.on('pty-output', (p) => { const evt = p as { runId: string; data: string; timestamp: Date | string }; ptyPublisher(evt.runId, evt.data, evt.timestamp); });`
     (the payload is opaque `unknown` on the facade EventEmitter; narrow with a typed local — NO `any`, prefer a small declared shape or a type guard).
   - This path bypasses `runEventBridge` entirely (the bridge is wired only for `'output'`/`'exit'`); raw PTY bytes are ephemeral live view, never persisted to `raw_events`. Do NOT add a `raw_events` INSERT.

5. **Allow the `cyboflow:pty:` channel prefix in `preload.ts` (both on and off).** In `main/src/preload.ts`, extend BOTH guards exactly like the existing `cyboflow:stream:` prefix:
   - on() at preload.ts:625: `if (validChannels.includes(channel) || channel.startsWith('cyboflow:stream:') || channel.startsWith('cyboflow:pty:')) {`
   - off() at preload.ts:638: same addition.
   - Without BOTH, `electron.on`/`off` silently no-op for the new channel (the allowlist drops unknown channels with no error), so the renderer (TASK-815) would never receive bytes.

6. **Extend the two named test suites.**
   - `main/src/services/panels/claude/__tests__/interactiveClaudeManager.test.ts`: using the existing fake-PTY harness, capture the second `ptyProcess.onData` registration, drive it with a multi-line ANSI chunk (e.g. `"\x1b[2J\x1b[Hline1\nline2\x1b[K"`), and assert exactly ONE `'pty-output'` event is emitted per `onData` call with `data` BYTE-EQUAL to the chunk (no split, no `\n` mutation) and `{ panelId, sessionId, runId, type:'pty', timestamp }` present. Assert `parseCliOutput(...)` still returns `[]` and that the `'output'` emit count is unchanged when a raw chunk arrives (only `session_info` + transcript-tail json emits fire on the output channel; the raw chunk produces a `pty-output`, never an `output`).
   - `main/src/services/__tests__/substrateDispatchFacade.test.ts`: using the existing two-manager fan-in harness, assert (a) `interactiveManager.emit('pty-output', payload)` is forwarded on the facade with the SAME object reference; (b) `sdkManager.emit('pty-output', payload)` is NOT forwarded; (c) after `facade.dispose()`, a subsequent `interactiveManager.emit('pty-output', …)` is no longer forwarded (listener removed).

7. **Run the gate.** Run the no-`any` grep from the ACs over all owned files, then `pnpm typecheck && pnpm lint` (both exit 0), then `pnpm test:unit` (exit 0; one-shot `vitest run`, NEVER `test:e2e`). If a `better-sqlite3` NODE_MODULE_VERSION error appears, run `pnpm rebuild better-sqlite3` first per CLAUDE.md before the main vitest run.

## Acceptance Criteria notes

- **Verbatim chunk is a CORRECTNESS claim, not cosmetic.** The base `setupProcessHandlers.onData` line-splits and re-appends `\n` for the per-line `parseCliOutput` path; the raw listener MUST forward `data` unmodified, because xterm.js downstream (TASK-815) needs byte-accurate ANSI — splitting on `\n` corrupts cursor/control sequences and breaks the live terminal render. The interactiveClaudeManager test asserts byte-equality precisely to lock this.
- **Additive isolation is by construction.** The new `'pty-output'` event never touches the `'output'` channel, so `runEventBridge.onOutput` (which listens on `'output'` and filters `type!=='json'` at runEventBridge.ts:207) never sees it, never narrows it, never INSERTs it to `raw_events`, and never publishes it on `cyboflow:stream`. The structured Workflow panel + the SDK path are therefore byte-identical (Q3). The facade re-emits BY REFERENCE, so the payload shape and the `panelId===runId===sessionId` invariant are preserved exactly as the existing `'output'` fan-in does.
- **Interactive-only by construction.** `ClaudeCodeManager` (SDK) runs `query()` in-process with `process: undefined as never` and never spawns a PTY — it has no `ptyProcess.onData` to emit from. The facade deliberately does NOT subscribe `sdkManager` to `'pty-output'`. The substrateDispatchFacade test asserts the SDK manager's `pty-output` is never forwarded so the channel can never carry an SDK event.
- **No persistence / no replay (v1).** Raw PTY bytes are ephemeral — there is no `raw_events` row and no ring buffer. A renderer that mounts AFTER spawn sees only bytes emitted after subscription. Backfill/replay is explicitly OUT of scope for this slice (a later decision; the structured path already persists for the Workflow panel).
- **Channel-prefix allowlist must be on BOTH on and off.** Missing either guard silently blocks the renderer subscription (TASK-815) with no error. The grep AC requires exactly two `cyboflow:pty:` startsWith hits.
- **Shared files are edited ADDITIVELY.** `interactiveClaudeManager.ts`, `substrateDispatchFacade.ts`, and `index.ts` are also owned by later tasks (TASK-817/818/819) on a dependsOn chain; this task adds ONLY the raw-byte seams above and must NOT remove or pre-empt the live-input relay (TASK-817), the persistence/completion rework (TASK-818), or the approval-gate wiring (TASK-819). NEVER reuse the turn-end marker or any completion path as the terminal/drained proxy — that is TASK-818's contract.

## Out of Scope

- The renderer `subscribeToPtyBytes` wrapper (mirror of `subscribeToStreamEvents` in `cyboflowApi.ts:87`), the `InteractiveTerminalView` xterm component, and the `RunChatView` transcript→terminal swap — all TASK-815 (IT-3), consuming the `cyboflow:pty:<runId>` channel this task stands up.
- The first-interaction warn dialog, INTERACTIVE pill / LIVE PTY bar chrome, and reduced-motion handling — TASK-816 (IT-4).
- Live-input relay (`orchestrator sendTurn` → `SubstrateDispatchFacade.relayInput` → `interactiveManager.sendInput`), the `runs.ts` relay mutations + dep-bag, the composer 'Continue' relay, the 'Interact anyway' raw-keystroke relay, and the PTY resize relay (xterm cols/rows → node-pty resize) — all TASK-817 (IT-5). This task is the OUTBOUND byte path only; there is no post-spawn input path here.
- The persistence/completion rework — gating `handleTurnEnd`'s EOF/`/exit` kill behind a persistent flag, the turn-end EVENT routed through the facade to a new RunExecutor handler that calls `restAwaitingReview` WITHOUT resolving the spawn promise, the explicit-termination resolver (End-session/Merge/Dismiss), the `recoverStaleAwaitingReview` boot-safety distinction, and the `teardownRun` bridge-disposal deferral — all TASK-818 (IT-6). This task does NOT change the completion model: `spawnCliProcess` still returns the same `spawnPromise` and `wireCompletionExit` is untouched.
- The interactive approval-gate wiring — calling `InteractiveSettingsWriter.write` on spawn and implementing the `denyInFlightShellApprovals`/`removeGeneratedSettings` teardown stubs — TASK-819 (IT-7), consuming TASK-810's shipped writer/hook/handler.
- Surfacing `run.substrate` to the renderer (the `runQueries.ts` SELECT + `ActiveRunRow` inference) — TASK-813 (IT-1), this task's dependency, already landed.
- Any change to `runEventBridge.ts`, `claudeCodeManager.ts`, `AbstractCliManager.ts`, or `shared/types/claudeStream.ts` (all READ-ONLY here): the raw bytes deliberately bypass the structured union and the bridge; extending `StreamEventType`/`StreamEnvelopePayload` with a `pty` arm is explicitly REJECTED (it would couple raw bytes into the closed discriminated union and the JSON-only bridge filter).
- A `pnpm test:e2e` gate — per CLAUDE.md the verifier AC gate is `pnpm test:unit` only.
