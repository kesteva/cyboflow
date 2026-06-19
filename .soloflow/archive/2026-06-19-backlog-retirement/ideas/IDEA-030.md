---
id: IDEA-030
type: FEATURE
status: materialized
created: 2026-06-02T00:00:00Z
materialized_as: plans
task_ids: [TASK-813, TASK-814, TASK-815, TASK-816, TASK-817, TASK-818, TASK-819]
source: design_workflow_interactive_chat_2026-06-01
epic: interactive-persistent-terminal
slices:
  - title: "Surface run.substrate to the renderer (IT-1 / TASK-813)"
    description: "Add the `substrate` column to the `listRunsHandler` SELECT (`runQueries.ts:24-32`) so every `cyboflow.runs.list` row carries it end-to-end. `WorkflowRunListRow.substrate?` already exists, `runs.list` already returns `: WorkflowRunListRow[]`, and `ActiveRunRow extends WorkflowRunListRow` is RouterOutputs-inferred — so this single SELECT column makes `activeRun.substrate` populate to `CyboflowRoot` with NO type edits and NO renderer edits. Legacy/pre-013 rows read back `'sdk'` from migration 013's `NOT NULL DEFAULT 'sdk'`. The standalone-typecheck invariant on `runQueries.ts` (no electron/better-sqlite3/services imports) is preserved; the cast stays `as WorkflowRunListRow[]`."
    value_statement: "The single load-bearing data plumb that unblocks the entire interactive gate — IT-3..IT-7 all branch on `activeRun.substrate === 'interactive'`. A column silently dropped from the SELECT is the FIND-SPRINT-024-4 silent-drop class, so a substrate round-trip test (interactive vs legacy-default) locks it."
  - title: "Raw-PTY backend pipeline (IT-2 / TASK-814)"
    description: "Stand up the additive, interactive-ONLY raw-byte path with NO parse/normalize and NO `cyboflow:stream` coupling. (1) In `InteractiveClaudeManager.spawnCliProcess`, AFTER `setupProcessHandlers` (~:454), register a SECOND `ptyProcess.onData` listener (node-pty is multi-listener; same precedent as `wireCompletionExit`'s extra `onExit`) emitting a NEW `'pty-output'` event `{ panelId, sessionId, runId, type:'pty', data:<verbatim chunk>, timestamp }` — WHOLE chunk, no line-split; `runId` in scope at ~:382. Base `onData`/`parseCliOutput` UNTOUCHED (`parseCliOutput` still returns `[]`). (2) `SubstrateDispatchFacade` adds an `interactivePtyHandler` fan-in re-emitting by reference (mirror `interactiveOutputHandler`), `off()`-ed in `dispose()`; the SDK manager is NEVER subscribed. (3) `index.ts` adds a `ptyPublisher` (mirror `cyboflowPublisher` :559-565) that does `webContents.send('cyboflow:pty:'+runId, …)`, wired near the RunExecutor ctor (~:712). (4) `preload.ts` allows `channel.startsWith('cyboflow:pty:')` in BOTH `on()` (~:625) and `off()` (~:638). Bypasses `runEventBridge` entirely (its `type!=='json'` filter at :207 drops `type:'pty'` by construction; never persisted to `raw_events`)."
    value_statement: "The byte-accurate transport that carries the live `claude --resume` ANSI stream to the renderer xterm. Additive by construction: the structured Workflow panel + SDK path stay byte-identical (Q3). Verbatim-chunk (no `\\n` split) is a correctness claim — splitting corrupts xterm cursor/control sequences."
  - title: "InteractiveTerminalView + RunChatView transcript swap (IT-3 / TASK-815)"
    description: "Render the live PTY terminal in the chat view for interactive runs. (1) Add `subscribeToPtyBytes({runId,onData})` to `cyboflowApi.ts` mirroring `subscribeToStreamEvents` (:87-108) — `electron.on('cyboflow:pty:'+runId)`, returns `off()` cleanup; chunk typed as `string` (raw byte channel — deliberately NOT a local `IPCResponse`, NOT the AppRouter-coupled `StreamEvent`). (2) NEW `InteractiveTerminalView.tsx`: clone `TerminalPanel`'s xterm `Terminal`+`FitAddon` lifecycle, `getTerminalTheme()` unchanged (read `--font-family-mono`, NOT hard-coded Menlo), fed by `subscribeToPtyBytes` → `term.write()` DIRECTLY (NEVER `cyboflowStore.streamEvents`). At-bottom-aware auto-scroll (re-pin only when already at bottom via `buffer.active.viewportY/baseY`). Read-only at this stage (`disableStdin:true`, no `onData`). (3) `RunChatView`: branch on `isInteractive` (read `run.substrate` from `activeRunsStore` the way `ChatInput` does) — swap ONLY the transcript region for `<InteractiveTerminalView/>`, keep `<PendingApprovalsForRun>` + `<ChatInput>` mounted, drop the `PromptNavigation` rail, keep `listUnifiedMessages` dormant."
    value_statement: "The interactive run's chat surface IS the live terminal, replacing the parsed-message transcript while preserving composer + approvals. Store-isolation (PTY bytes never enter `streamEvents`) is the renderer-side proof of Q3 panel-preservation; the `sdk` branch stays byte-for-byte the prior behavior."
  - title: "Interactive chrome + first-interaction warn dialog + reduced-motion (IT-4 / TASK-816)"
    description: "Add the design chrome and the deliberate guardrail modal. (1) NEW `InteractiveWarnDialog.tsx` on `ui/Modal` (NOT a hand-rolled scrim): hazard-stripe eyebrow 'Direct terminal access', warning copy, and two actions — primary 'Use chat instead' (focuses the composer) and ghost 'Interact anyway' (grants terminal focus + flips the per-run keystroke-relay flag). Opened on the FIRST mousedown on the terminal surface, shown at most ONCE per run (`has-warned` flag). (2) INTERACTIVE pill (terracotta, pulsing dot) + LIVE PTY session bar (`claude --resume <id>`, pid, tty, elapsed counter, token meter) as presentational chrome around `InteractiveTerminalView` (additive edits — TASK-815 committed first). (3) `prefers-reduced-motion` guard drops pulse/blink/spinner loops. Interactive-only and presentational — zero production change to the Workflow panel or SDK path (Q3). The `has-warned` + `relay-enabled` flags live in component/store state and are CONSUMED by TASK-817."
    value_statement: "The deliberate human-keystrokes-vs-cyboflow-orchestration guardrail. Show-once-per-run + dual-action callbacks are correctness-bearing behaviors TASK-817 consumes; the reduced-motion drop is an accessibility contract."
  - title: "sendTurn live-input relay (IT-5 / TASK-817)"
    description: "Add the ONLY post-spawn input path into a LIVE interactive run (no `continuePanel` kill+respawn — today the only 'continue' paths kill+respawn a fresh REPL). (1) `SubstrateDispatchFacade.relayInput(panelId,text)` + `relayResize(panelId,cols,rows)` resolve the manager via `resolveManager` and, for the interactive manager, call `sendInput(panelId,text)` / a resize relay into the live node-pty; SDK substrate NO-OPs. (2) `runs.relayInput({runId,text})` + `runs.relayResize({runId,cols,rows})` protected mutations via a NEW dep-bag (mirror `setCancelAndRestartDeps` :54), AppRouter-inferred zod inputs, `runId===panelId` invariant, throw `METHOD_NOT_SUPPORTED` until `setRelayDeps()` is wired. (3) `index.ts` wires the relay dep-bag with the facade. (4) `ChatInput`: NEW enabled `'workflow-interactive'` mode — placeholder 'Message the running session — relayed safely…', 'Continue' relays `text+'\\n'` as a real REPL turn via `runs.relayInput`. (5) `InteractiveTerminalView`: when the per-run relay flag is set ('Interact anyway'), `xterm.onData` relays VERBATIM (no `\\n`); `ResizeObserver` → `relayResize`. The resize SEAM on the manager lands in TASK-818 — TASK-817's `relayResize` feature-detects a `resizePanel` capability and no-ops until it exists."
    value_statement: "Makes the terminal truly two-way and lets the composer drive the persistent REPL. The composer `'\\n'` (complete turn) vs raw-verbatim (xterm already encodes Enter as `\\r`) split is load-bearing; SDK no-op is the Q3 guarantee."
  - title: "Persistence / completion rework (IT-6 / TASK-818)"
    description: "Make the interactive substrate a TRUE persistent multi-turn session; SDK path UNTOUCHED (gate everything behind a substrate/persistent flag). (1) GATE THE KILL: in `handleTurnEnd` (:593-608), when persistent, do NOT write `EOF_BYTE`+`/exit`; emit a NEW turn-end EVENT and leave the REPL alive — make `turnEnded` per-turn re-armable (not one-shot). (2) EVENT-DRIVEN REST: route the turn-end event through the `SubstrateDispatchFacade` EventEmitter to a NEW `RunExecutor` handler that calls `restAwaitingReview` WITHOUT resolving the spawn promise (promise stays pending across turns; safely no-ops if a gate is open — `restAwaitingReview` guarded on `status='running'` :489-506). Defer `teardownRun` (:283 finally) so it does NOT dispose the bridge while the REPL is alive. (3) EXPLICIT TERMINATION = the ONLY spawn-promise resolver: wire End-session / Merge / Dismiss (`runs.ts`) and/or `killProcess` to write the now-conditional `EOF`+`/exit` so `wireCompletionExit.onExit` (:618-633) fires its existing resolve/reject; add `endSession` to TASK-817's relay dep-bag (do NOT create a competing bag). (4) SDK path drains via the `query()` iterator — the new event path is gated OFF for sdk. Plus the `recoverStaleAwaitingReview` boot-safety analysis (a persistent run is only 'live' within one process; after restart the PTY is dead and existing recovery is correct — locked by a test)."
    value_statement: "The central coupling: RunExecutor today equates spawn-promise resolution with run-done, and TASK-808's first-turn EOF/'/exit' kill is the ONLY thing breaking persistence. Get it wrong and either the run hangs in `running` forever, or the spawn promise resolves early and `teardownRun` orphans the live PTY. NEVER reuse the turn-end marker as the terminal/drained proxy — it fires every turn."
  - title: "Interactive approval-gate wiring (IT-7 / TASK-819)"
    description: "Consume TASK-810's shipped-but-unwired parts (`InteractiveSettingsWriter` + `preToolUseShellHook` + `handleShellApprovalRequest`/`cancelInFlightShellApprovals`) — do NOT re-implement them — and finish the manager-side wiring. (1) On spawn, call `InteractiveSettingsWriter.write(worktreePath, { permissionMode })` (logger PASSED) to install the PreToolUse `'*'` hook into `<worktree>/.claude/settings.json`; drop the dangling `--settings <.cyboflow/interactive-settings.json>` flag from `buildCommandArgs` (nothing ever wrote it) so `claude` reads the writer-installed hook from its default path. Writer's own `permissionMode==='ignore'` skip is the single source of truth. (2) Implement `denyInFlightShellApprovals` via an injected `setShellApprovalCanceller` seam delegating to `cancelInFlightShellApprovals(runId)` — fired BEFORE `clearPendingForRun` (reorder within `teardownRun`) so the held-open socket gets a real deny before the DB settle. (3) Implement `removeGeneratedSettings` via `InteractiveSettingsWriter.remove(worktreePath)` (merge-safe; preserves user keys). Because TASK-818 keeps the REPL alive across gates, the socket-blocking approval design is now race-free."
    value_statement: "Closes the interactive safety contract: tool calls in a live interactive REPL actually pause for human review, and torn-down runs don't leak a blocked hook subprocess on a held-open socket. The dangling `--settings` flag was the live bug (no hook → no gating)."
open_questions:
  - "Raw-PTY replay/backfill: v1 has NO persistence/ring buffer for raw bytes — a renderer that mounts AFTER spawn (or after a run reopen) sees only bytes emitted post-subscription. The structured path keeps history via `raw_events`; a per-run scrollback buffer for late mount is a possible future iteration, not in IDEA-030."
  - "Distinct DB live-state status: TASK-818 rests a persistent run in the existing `awaiting_review` between turns rather than introducing a new `awaiting_input`/`idle-live` status to disambiguate turn-end-rest from approval-gate awaiting_review. The minimal boot-recovery guard (boot recovery only runs at startup; a within-session persistent run is never subject to it) is taken instead. A dedicated status is deferred."
  - "LIVE PTY bar identity fields (pid, tty, elapsed, token meter): TASK-816 renders the fields with stable placeholders where the value is not yet plumbed; the real wiring of pid/tty/token-usage to the renderer is a follow-up — the AC only requires the fields render and carry the session-identity shape."
  - "AskUserQuestion on the interactive substrate is intentionally NOT wired (a shell PreToolUse hook has no `updatedInput` channel — native-TUI-only, Probe A2). The handler treats an AskUserQuestion shell-approval-request as a normal gate; no QuestionRouter wiring is added."
assumptions:
  - "All 7 tasks run SEQUENTIALLY in ONE worktree (like IDEA-029 / IDEA-013). Every `depends_on` edge means 'prior task committed first', so the four shared backend files (`interactiveClaudeManager.ts`, `substrateDispatchFacade.ts`, `runExecutor.ts`, `runs.ts`) plus `index.ts` are edited ADDITIVELY in dependency order and no two tasks hold the same file concurrently."
  - "TASK-810 already shipped `InteractiveSettingsWriter`, `preToolUseShellHook.ts`, and `mcpQueryHandler.handleShellApprovalRequest`/`cancelInFlightShellApprovals`; TASK-819 CONSUMES them read-only (0 changed lines in their files)."
  - "Migration 013 already declares `workflow_runs.substrate TEXT NOT NULL DEFAULT 'sdk' CHECK (substrate IN ('sdk','interactive'))`, and `WorkflowRunListRow.substrate?` / `WorkflowRunRow.substrate?` already exist in `shared/types/workflows.ts` — so IT-1 is a pure SELECT-column plumb with no type or migration work."
  - "The `runId === panelId === sessionId` orchestrator invariant holds (substrateDispatchFacade.ts:21,101-102), so the runs relay/close-out mutations map `runId → panelId` directly with no lookup."
  - "The SDK substrate (`ClaudeCodeManager`) has no PTY (`process: undefined as never`) and drains via the `query()` iterator — so every new interactive behavior is gated off for sdk by construction, and the SDK + structured Workflow panel paths stay byte-identical (Q3)."
research_recommendation: not_needed
research_rationale: "Two completed multi-agent understanding workflows already produced adversarially-reviewed, file:line-grounded findings: the terminal-pipeline/components plan (`wfnkftsqa.output`) and the execution-model/lifecycle verdict (`wnmafcslw.output`), plus a hi-fi design handoff (`design_handoff_interactive_chat/README.md`). All locked decisions are user-confirmed product calls anchored in the repo; no external/ecosystem research is needed."
---

# Live interactive terminal in the chat view + persistent multi-turn interactive session

## Context

The interactive CLI substrate (`substrate==='interactive'`, the interactive-PTY twin of the
SDK path landed by IDEA-013) currently renders through the same parsed-message transcript
surface as the SDK substrate, and — fatally — DIES after the first turn: TASK-808's
`InteractiveClaudeManager.handleTurnEnd` writes `EOF_BYTE`+`/exit` on the FIRST turn-end
(the end of EVERY assistant turn, including every in-session checkpoint), so the REPL
never survives a multi-turn conversation. IDEA-030 does two coupled things:

1. **Render a LIVE xterm.js terminal of the interactive `claude --resume` PTY DIRECTLY in
   the chat view**, replacing the parsed-message surface for interactive runs. Raw PTY
   bytes travel a dedicated, additive, parse-free channel (`cyboflow:pty:<runId>`),
   byte-for-byte into `term.write()` — never into the structured `cyboflow:stream`
   pipeline. The structured Workflow panel + the SDK path stay byte-identical (Q3).
2. **Make the interactive substrate a TRUE persistent multi-turn session** — it must NOT
   die after each turn or at an approval gate. A session is finalized only by an EXPLICIT
   End/Stop control (Merge / Dismiss / killProcess; a natural `/exit` also counts).

The terminal is fully interactive from mount (two-way), gated ONCE per run by a
first-interaction warn modal — the deliberate human-keystrokes-vs-orchestration guardrail.
'Use chat instead' focuses the composer; 'Interact anyway' grants terminal focus + enables
verbatim keystroke relay for the session.

## Locked decisions (user-confirmed — not relitigated)

- **Direct raw-PTY render in chat.** Reuse the existing xterm setup
  (`TerminalPanel.tsx` + `terminalTheme.ts`; `@xterm/*` already deps). For interactive
  runs the live terminal REPLACES the transcript region; composer + approvals stay mounted;
  the prompt-navigation rail is dropped.
- **Fully interactive from mount, gated ONCE by a first-interaction warn modal.**
- **TRUE persistent multi-turn session** — no death at turn-end / approval gates; finalized
  by explicit End/Stop (or natural `/exit`).
- **Raw-PTY rendering is DIRECT** — a dedicated raw-byte channel, NOT `cyboflow:stream`;
  additive; the structured Workflow panel + SDK path stay byte-identical.

## Deferred (NOT in IDEA-030)

Dynamic-workflow def-driven prompts and real per-stage `current_step_id` step advancement
(mapping transcript step-report markers back into `stepTransitionBridge` during the run) are
explicitly DEFERRED to a separate follow-up iteration. Step tracking stays observational and
main-session-only (the IDEA-029 model). Raw-PTY persistence/replay and a dedicated DB
live-state status are likewise deferred (see open questions).

## Execution model (sequential, one worktree)

All 7 tasks run SEQUENTIALLY in ONE worktree (like IDEA-029 / IDEA-013). Every `depends_on`
edge means **'prior task committed first'**, so each shared file is edited ADDITIVELY in
dependency order and no two tasks hold the same file concurrently. The shared-file chains:

- `interactiveClaudeManager.ts` — TASK-814 → TASK-818 → TASK-819 (distinct regions:
  814 = second `onData` `pty-output` emit; 818 = gate `handleTurnEnd` kill + turn-end event
  + persistent flag; 819 = `write()` on spawn + the two teardown stubs).
- `substrateDispatchFacade.ts` — TASK-814 → TASK-817 → TASK-818 (814 = `pty-output` fan-in;
  817 = `relayInput`/`relayResize`; 818 = `turn-end` fan-in).
- `runExecutor.ts` — TASK-818 ONLY (sole editor; the single-spawn/drained contract + the
  teardown finally).
- `runs.ts` (trpc) — TASK-817 → TASK-818 (817 = relay mutations + dep-bag; 818 = `endSession`
  added to that bag + End/Merge/Dismiss as the explicit resolver).
- `index.ts` — TASK-814 → TASK-817 → TASK-818 (814 = `ptyPublisher`; 817 = `setRelayDeps`;
  818 = `endSession` collaborator + the `setShellApprovalCanceller` boot wiring that TASK-819
  delegates upstream).
- `preload.ts` — TASK-814 ONLY. `cyboflowApi.ts`, `RunChatView.tsx` — TASK-815 ONLY.
  `InteractiveTerminalView.tsx` — TASK-815 (creates) → TASK-816 (chrome + warn trigger) →
  TASK-817 (keystroke relay + resize). `ChatInput.tsx` — TASK-817 ONLY.
  `InteractiveWarnDialog.tsx` — TASK-816 ONLY.

## Slice → task map (DAG is a strict chain)

```
TASK-813 (IT-1) ─> TASK-814 (IT-2) ─> TASK-815 (IT-3) ─> TASK-816 (IT-4)
  ─> TASK-817 (IT-5) ─> TASK-818 (IT-6) ─> TASK-819 (IT-7)
```

| Slice | Task | Delivers |
|-------|------|----------|
| IT-1  | TASK-813 | `substrate` column in the list SELECT → renderer inference |
| IT-2  | TASK-814 | raw-PTY backend: emit → facade fan-in → ptyPublisher → channel → preload |
| IT-3  | TASK-815 | `InteractiveTerminalView` (xterm) + `RunChatView` transcript swap |
| IT-4  | TASK-816 | INTERACTIVE pill + LIVE PTY bar + first-interaction warn dialog + reduced-motion |
| IT-5  | TASK-817 | `sendTurn` live-input: relayInput/relayResize + runs mutations + composer relay + keystroke relay |
| IT-6  | TASK-818 | persistence/completion rework (gate turn-end kill, event-driven rest, explicit-termination resolver) |
| IT-7  | TASK-819 | interactive approval-gate wiring (consumes shipped-but-unwired TASK-810 parts) |

## Key risks (carry into execution)

1. **The completion-model coupling (TASK-818) is THE load-bearing risk.** RunExecutor
   structurally equates `spawnCliProcess`-resolution with "turn/run done → drained →
   awaiting_review" (`runExecutor.ts:257-269`). Two failure modes the tests MUST lock:
   (a) if the new event-driven rest is mis-wired the run sits in `running` forever (no
   `awaiting_review`, no Merge/Dismiss close-out, UI hangs); (b) if the spawn promise
   resolves early, `teardownRun` (:283 finally) disposes the bridge/pipeline while the REPL
   is alive — orphaning the live PTY. NEVER reuse the turn-end marker as the terminal/drained
   proxy: it fires on EVERY assistant turn boundary. The only terminal signal is the explicit
   `EOF`+`/exit` from End-session / Merge / Dismiss / killProcess.
2. **`recoverStaleAwaitingReview` boot collision (TASK-818).** The boot-recovery sweep
   (`approvalRouter.ts:493-524`, READONLY) fails `awaiting_review` runs that still hold a
   `pending` approval on boot. A persistent live interactive run that rests in
   `awaiting_review` between turns must NOT be killed. Resolution: a persistent run is only
   "live" within one process — after a restart the PTY is dead and the existing recovery is
   correct — and boot recovery runs once at startup before any within-session persistent run
   exists. Locked by a test; a distinct DB live-state status is deferred.

## TASK-810 consumption (IT-7)

TASK-819 CONSUMES the shipped-but-unwired TASK-810 components (`InteractiveSettingsWriter`,
`preToolUseShellHook.ts`, `mcpQueryHandler.handleShellApprovalRequest` /
`cancelInFlightShellApprovals`) and finishes only the manager-side wiring
(`write()` on spawn, the `deny`/`remove` teardown stubs). Those three files stay at 0
changed lines. The dangling `--settings <.cyboflow/interactive-settings.json>` flag (which
nothing ever wrote → no hook → no gating) is dropped so `claude` reads the writer-installed
hook from its default `.claude/settings.json`.

## Out of scope (v1)

- Dynamic-workflow def-driven prompts + real per-stage step advancement (separate follow-up).
- Raw-PTY persistence / replay / scrollback buffer for late mount or run reopen.
- A new DB run status to disambiguate turn-end-rest from approval-gate `awaiting_review`.
- AskUserQuestion routing on the interactive substrate (shell PreToolUse hook has no
  `updatedInput` channel — native-TUI-only).
- Any change to the SDK substrate, the structured Workflow panel, the `cyboflow:stream`
  envelope, or `runEventBridge` — must stay byte-identical (Q3).

## Raw Input

> User, 2026-06-01: Render a live xterm.js terminal of the interactive `claude --resume`
> PTY directly in the chat view, replacing the parsed-message surface for interactive runs;
> fully interactive from mount, gated once by a first-interaction warn modal; make the
> interactive substrate a true persistent multi-turn session finalized by an explicit
> End/Stop; raw-PTY rendering is direct on a dedicated channel (additive — structured panel
> + SDK path byte-identical); dynamic-workflow def-driven prompts + per-stage step
> advancement deferred to a follow-up.
