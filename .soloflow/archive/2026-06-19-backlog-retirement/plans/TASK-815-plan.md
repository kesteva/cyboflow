---
id: TASK-815
idea: IDEA-030
status: ready
created: 2026-06-02T00:00:00Z
source: IDEA-030
epic: interactive-persistent-terminal
files_owned:
  - frontend/src/components/cyboflow/InteractiveTerminalView.tsx
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/components/cyboflow/RunChatView.tsx
  - frontend/src/components/cyboflow/__tests__/InteractiveTerminalView.test.tsx
  - frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx
files_readonly:
  - frontend/src/components/panels/TerminalPanel.tsx
  - frontend/src/utils/terminalTheme.ts
  - frontend/src/stores/activeRunsStore.ts
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/components/cyboflow/ChatInput.tsx
acceptance_criteria:
  - criterion: "subscribeToPtyBytes({ runId, onData }) is added to cyboflowApi.ts mirroring subscribeToStreamEvents (cyboflowApi.ts:87-108): it registers electron.on(`cyboflow:pty:${runId}`, handler), types the raw chunk as a string (the verbatim PTY ANSI bytes — NOT via a local IPCResponse, NOT via the AppRouter-coupled StreamEvent; this is a raw IPC channel), and returns a working off() cleanup that calls electron.off(channel, handler)."
    verification: "grep -n \"subscribeToPtyBytes\" frontend/src/utils/cyboflowApi.ts shows the new export; grep -n \"cyboflow:pty:\" frontend/src/utils/cyboflowApi.ts shows the channel build; grep -nE \"interface IPCResponse|StreamEvent\\b\" frontend/src/utils/cyboflowApi.ts shows subscribeToPtyBytes does NOT re-use the StreamEvent type or declare an IPCResponse for the chunk. InteractiveTerminalView.test.tsx mocks electron.on and asserts the registered channel is `cyboflow:pty:${runId}` and that the returned cleanup calls electron.off with the same channel+handler."
  - criterion: "InteractiveTerminalView.tsx clones TerminalPanel's xterm Terminal+FitAddon construct/open/fit/dispose lifecycle (TerminalPanel.tsx:92-110 init, :108-110 open+fit, :199-216 dispose), uses getTerminalTheme() unchanged from terminalTheme.ts, and reads the mono font from the --font-family-mono CSS variable (NOT the hard-coded 'Menlo, Monaco, …' string at TerminalPanel.tsx:95). It subscribes via subscribeToPtyBytes and writes each raw chunk DIRECTLY to term.write(chunk) — NEVER into cyboflowStore.streamEvents."
    verification: "grep -n \"getTerminalTheme\" frontend/src/components/cyboflow/InteractiveTerminalView.tsx returns >=1; grep -n \"font-family-mono\" frontend/src/components/cyboflow/InteractiveTerminalView.tsx returns >=1; grep -nE \"Menlo|streamEvents|appendStreamEvent\" frontend/src/components/cyboflow/InteractiveTerminalView.tsx returns 0. InteractiveTerminalView.test.tsx asserts term.write is called with the exact chunk delivered on the channel and that the cyboflowStore.streamEvents array is untouched (store.getState().streamEvents.length stays 0)."
  - criterion: "InteractiveTerminalView is read-only at this stage: the xterm is constructed with disableStdin true and registers NO onData input relay (keystroke input + resize are owned by TASK-817). It implements at-bottom-aware auto-scroll — it re-pins to the bottom on write ONLY when the viewport is already at the bottom, computed from buffer.active.viewportY vs baseY."
    verification: "grep -nE \"disableStdin\" frontend/src/components/cyboflow/InteractiveTerminalView.tsx shows disableStdin: true; grep -nE \"\\.onData\\(\" frontend/src/components/cyboflow/InteractiveTerminalView.tsx returns 0 (no input relay yet); grep -nE \"viewportY|baseY\" frontend/src/components/cyboflow/InteractiveTerminalView.tsx returns >=1 (at-bottom check). InteractiveTerminalView.test.tsx asserts no input mutation is sent on mount."
  - criterion: "RunChatView reads run.substrate the way ChatInput does (scan activeRunsStore.runsByProject for the row whose id === runId — mirror ChatInput.tsx:54,68-75) and computes isInteractive = run?.substrate === 'interactive'. When isInteractive, it swaps ONLY the transcript region (RunChatView.tsx:399-422) for <InteractiveTerminalView runId={runId} />, keeps <PendingApprovalsForRun runId={runId}/> (:424) and <ChatInput runId={runId}/> (:426) mounted, and DROPS the right PromptNavigation rail (:430-438) plus the sidebar toggle button (:388-397). When substrate is 'sdk' (or undefined), it renders the existing ChatTranscript + PromptNavigation rail unchanged."
    verification: "grep -n \"InteractiveTerminalView\" frontend/src/components/cyboflow/RunChatView.tsx shows the interactive branch; grep -nE \"substrate|runsByProject|useActiveRunsStore\" frontend/src/components/cyboflow/RunChatView.tsx shows the store-read substrate resolution. RunChatView.test.tsx covers BOTH branches by substrate: interactive → InteractiveTerminalView present AND PromptNavigation absent; sdk → ChatTranscript present AND PromptNavigation present."
  - criterion: "ChatInput and PendingApprovalsForRun stay mounted in the interactive branch (composer + approvals are preserved; only the transcript region and the right rail change)."
    verification: "RunChatView.test.tsx asserts, in interactive mode, that the ChatInput composer testid and PendingApprovalsForRun are both present in the rendered output (alongside InteractiveTerminalView)."
  - criterion: "The listUnifiedMessages pipeline stays dormant in interactive mode (no double-render of the conversation): the parsed-message query/debounce machinery is skipped or its output is not rendered when isInteractive, so the live terminal is the sole transcript surface."
    verification: "RunChatView.test.tsx asserts that in interactive mode the ChatTranscript is NOT in the rendered output (only InteractiveTerminalView); grep -n \"isInteractive\" frontend/src/components/cyboflow/RunChatView.tsx shows the gate is applied to the transcript render path."
  - criterion: "tRPC/IPC typing rules hold for all touched renderer code: no local IPCResponse interface, no `(evt: unknown)` + hand-rolled shape guard, and the substrate value read from the store is the AppRouter-inferred ActiveRunRow.substrate (never a locally re-declared substrate union). The raw-PTY chunk on the dedicated cyboflow:pty: channel is the one deliberate exception (typed as string — it is a raw byte channel, not an AppRouter output)."
    verification: "grep -rnE \"interface IPCResponse|onData: \\(evt: unknown\\)\" frontend/src/utils/cyboflowApi.ts frontend/src/components/cyboflow/InteractiveTerminalView.tsx frontend/src/components/cyboflow/RunChatView.tsx returns 0; grep -nE \"type .*Substrate.*=|'sdk' \\| 'interactive'\" frontend/src/components/cyboflow/RunChatView.tsx frontend/src/components/cyboflow/InteractiveTerminalView.tsx returns 0 (no re-declared substrate union)."
  - criterion: "No use of the `any` type in any file this task owns."
    verification: "grep -nE \":\\s*any(\\b|\\[)|<any>|as any\" frontend/src/components/cyboflow/InteractiveTerminalView.tsx frontend/src/utils/cyboflowApi.ts frontend/src/components/cyboflow/RunChatView.tsx frontend/src/components/cyboflow/__tests__/InteractiveTerminalView.test.tsx frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx returns 0 matches"
  - criterion: "The two named vitest suites pass and the touched code type-checks and lints clean."
    verification: "pnpm --filter frontend test InteractiveTerminalView && pnpm --filter frontend test RunChatView exit 0; pnpm typecheck && pnpm lint exit 0"
  - criterion: "Full unit gate green."
    verification: "pnpm test:unit exits 0 (one-shot vitest run; NEVER pnpm test:e2e). If a better-sqlite3 NODE_MODULE_VERSION error appears, run `pnpm rebuild better-sqlite3` first per CLAUDE.md."
depends_on: [TASK-814]
estimated_complexity: M
test_strategy:
  needed: true
  justification: "This slice introduces the renderer half of the raw-PTY pipeline: a new IPC subscription (subscribeToPtyBytes) that must hit the exact dedicated channel and never leak into the structured store, a new xterm view that must write raw bytes directly to the terminal, and a substrate-gated branch in RunChatView that swaps the transcript surface while preserving the composer and approvals. The channel-correctness, the streamEvents-isolation invariant (Q3 panel-preservation — the structured store must stay untouched), the read-only-at-this-stage contract, and the two-way substrate branch are correctness claims that must be locked by unit tests rather than asserted by eye. The xterm lifecycle is mocked (jsdom has no real terminal); tests verify the wiring (channel, write, cleanup, store-isolation) and the RunChatView branch logic, not pixel rendering."
  targets:
    - behavior: "subscribeToPtyBytes registers on `cyboflow:pty:${runId}`, forwards each raw string chunk to onData, returns a cleanup that off()s the same channel+handler, and never touches cyboflowStore.streamEvents; InteractiveTerminalView writes the chunk to term.write and constructs the xterm with disableStdin true / no onData relay."
      test_file: "frontend/src/components/cyboflow/__tests__/InteractiveTerminalView.test.tsx"
      type: unit
    - behavior: "RunChatView branches on run.substrate: 'interactive' renders InteractiveTerminalView, keeps ChatInput + PendingApprovalsForRun mounted, and drops the PromptNavigation rail; 'sdk' renders ChatTranscript + the rail unchanged (and the listUnifiedMessages-fed ChatTranscript stays dormant in interactive mode)."
      test_file: "frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx"
      type: unit
---

# InteractiveTerminalView (xterm fed from subscribeToPtyBytes) + RunChatView transcript swap

## Objective

Render the live interactive `claude --resume` PTY as a real xterm.js terminal DIRECTLY in the chat view, replacing the parsed-message transcript surface for interactive-substrate runs while keeping the composer (`ChatInput`) and the approvals strip (`PendingApprovalsForRun`) mounted. This is the renderer terminus of the raw-PTY pipeline whose backend half (manager emit → facade fan-in → `ptyPublisher` → `cyboflow:pty:<runId>` channel → preload allowlist) landed in TASK-814. This task adds the renderer subscription (`subscribeToPtyBytes`), a new `InteractiveTerminalView` xterm component fed by it, and the substrate-gated swap inside `RunChatView`.

Three hard invariants govern the work:

1. **Q3 panel-preservation / store-isolation.** Raw PTY bytes go straight to `term.write()` and NEVER into `cyboflowStore.streamEvents`. The structured `cyboflow:stream:<runId>` pipeline (Workflow panel + SDK path) stays byte-identical — this task touches none of it. The raw bytes ride a SEPARATE channel that the structured `runEventBridge` drops by construction (`type !== 'json'` filter), so there is zero chance of cross-contamination.
2. **Read-only at this stage.** The terminal is view-only here: `disableStdin: true`, NO `onData` input relay, NO resize relay. Two-way interactivity (keystroke relay + the first-interaction warn modal + PTY resize) is owned by TASK-816 (chrome + warn dialog) and TASK-817 (`sendTurn` relay + resize), which edit this same file ADDITIVELY on the dependency chain 815→816→817. Do NOT add input wiring here.
3. **Additive, store-read substrate gate.** `RunChatView` reads `run.substrate` from `activeRunsStore` the exact way `ChatInput` already does (scan `runsByProject` for the row whose `id === runId`), and branches with a single `isInteractive` conditional. The 'sdk' path renders the existing `ChatTranscript` + `PromptNavigation` rail unchanged; only the interactive path swaps the transcript region and drops the rail.

`subscribeToPtyBytes` is the one deliberate exception to the AppRouter-inference rule: the `cyboflow:pty:<runId>` channel carries raw ANSI bytes, not a tRPC output, so the chunk is typed as a plain `string` — NOT via a local `IPCResponse`, NOT by reusing the AppRouter-coupled `StreamEvent` type. Everything else (the substrate value, any tRPC reads left in the sdk branch) stays AppRouter-inferred.

## Implementation Steps

1. **Add `subscribeToPtyBytes` to `frontend/src/utils/cyboflowApi.ts`** — clone `subscribeToStreamEvents` (cyboflowApi.ts:87-108) verbatim in structure:
   - Signature `subscribeToPtyBytes({ runId, onData }: { runId: string; onData: (chunk: string) => void }): () => void`.
   - `const electron = requireElectron();` then `const channel = \`cyboflow:pty:${runId}\`;` (mirror cyboflowApi.ts:94-95).
   - `const handler = (...args: unknown[]) => { onData(args[0] as string); };` — the chunk is the verbatim PTY ANSI string the backend `ptyPublisher` (TASK-814) sent as the payload. Do NOT cast to `StreamEvent`; do NOT declare an `IPCResponse`.
   - `electron.on(channel, handler); return () => electron.off(channel, handler);` (mirror cyboflowApi.ts:106-107).
   - Add a doc-comment noting this is a RAW byte channel (not the structured `cyboflow:stream:` envelope) and that bytes feed `xterm.Terminal.write()` directly, never `cyboflowStore.streamEvents`.

2. **Create `frontend/src/components/cyboflow/InteractiveTerminalView.tsx`** — a NEW component `function InteractiveTerminalView({ runId }: { runId: string }): ReactElement`, cloning the xterm lifecycle from `TerminalPanel.tsx`:
   - Import `Terminal` from `@xterm/xterm`, `FitAddon` from `@xterm/addon-fit`, the xterm css (`'@xterm/xterm/css/xterm.css'`, TerminalPanel.tsx:11 precedent), and `getTerminalTheme` from `../../utils/terminalTheme`. `@xterm/*` are already deps (frontend/package.json) — no install.
   - A `useRef<HTMLDivElement>` container + a `useEffect([runId])` that constructs the terminal: `new Terminal({ fontSize: 14, fontFamily: getCSSMonoFont(), theme: getTerminalTheme(), scrollback: 50000, disableStdin: true, convertEol: false })`. Mirror TerminalPanel.tsx:93-98 BUT (a) read the mono font from the `--font-family-mono` CSS variable instead of the hard-coded `'Menlo, Monaco, …'` at TerminalPanel.tsx:95 (read it with `getComputedStyle(document.documentElement).getPropertyValue('--font-family-mono').trim()` and fall back to `'monospace'` if empty), and (b) set `disableStdin: true` — this stage is view-only.
   - `const fit = new FitAddon(); term.loadAddon(fit); term.open(containerRef.current); fit.fit();` (mirror TerminalPanel.tsx:101-110).
   - Subscribe AFTER open: `const off = subscribeToPtyBytes({ runId, onData: (chunk) => { writeWithAutoScroll(term, fit, chunk); } });`. The write goes DIRECTLY to `term.write(chunk)` — NEVER into `cyboflowStore.streamEvents`.
   - **At-bottom-aware auto-scroll** (handoff §Auto-scroll; net-new vs TerminalPanel): before each write, compute whether the viewport is already pinned to the bottom via `const buf = term.buffer.active; const atBottom = buf.viewportY >= buf.baseY;`. Write the chunk, then `if (atBottom) term.scrollToBottom();`. When the user has scrolled up (`viewportY < baseY`), do NOT re-pin.
   - A `ResizeObserver` on the container that calls `fit.fit()` on resize (mirror TerminalPanel.tsx:162-172) — but do NOT relay cols/rows to the PTY here (resize relay is TASK-817). Fit only adjusts the local xterm geometry.
   - Cleanup: the `useEffect` return disposes the `ResizeObserver`, calls `off()`, and `term.dispose()` / `fit.dispose()` (mirror TerminalPanel.tsx:174-180,199-216). Guard against double-dispose with a `disposed` flag like TerminalPanel.
   - Do NOT register `term.onData(...)` (no input relay) and do NOT call any `terminal:input`/`terminal:resize` IPC — those are the SDK/panel terminal's wiring, not this view's. Keystroke relay arrives in TASK-817.

3. **Branch `RunChatView` on substrate (`frontend/src/components/cyboflow/RunChatView.tsx`).** Resolve the run row from `activeRunsStore` the way `ChatInput` does (ChatInput.tsx:54,68-75): add `const runsByProject = useActiveRunsStore((s) => s.runsByProject);` and a `useMemo` that scans `Object.values(runsByProject)` for the row whose `id === runId`, then `const isInteractive = run?.substrate === 'interactive';`. (`ActiveRunRow extends WorkflowRunListRow` already declares the optional `substrate` field; TASK-813 populated it in the list SELECT, so the value is real by this task's depends-on chain. Do NOT re-declare the substrate union — read the inferred field.)
   - In the non-null-`runId` return (RunChatView.tsx:384-440), gate the transcript region (RunChatView.tsx:399-422): when `isInteractive`, render `<InteractiveTerminalView runId={runId} />` in place of the `loadError`/`<ChatTranscript>` block; otherwise render the existing block unchanged.
   - Keep `<PendingApprovalsForRun runId={runId} />` (RunChatView.tsx:424) and `<ChatInput runId={runId} />` (RunChatView.tsx:426) mounted in BOTH branches — do NOT move or unmount them.
   - When `isInteractive`, DROP the right `PromptNavigation` rail (RunChatView.tsx:430-438) — gate it on `!isInteractive` — and DROP the prompt-rail toggle button (RunChatView.tsx:388-397). Skip the `promptMarkers` computation (RunChatView.tsx:334-353) in interactive mode (it derives from `filteredMessages`, which is empty/dormant there).
   - Keep the `listUnifiedMessages` pipeline DORMANT in interactive mode: the simplest correct approach is to NOT render `ChatTranscript` (its output) when `isInteractive` so the conversation is not double-rendered. The query machinery (RunChatView.tsx:109-212) may stay wired but its output must not reach the DOM in interactive mode; the live terminal is the sole transcript surface. (Skipping the fetch entirely when `isInteractive` is acceptable and slightly cleaner, but not required for this AC — the load-bearing claim is "no `ChatTranscript` in the DOM in interactive mode".)

4. **Write `frontend/src/components/cyboflow/__tests__/InteractiveTerminalView.test.tsx`.** Mock `@xterm/xterm` (`Terminal` with `open`, `write`, `loadAddon`, `dispose`, `scrollToBottom`, and a `buffer.active` exposing `viewportY`/`baseY`), `@xterm/addon-fit` (`FitAddon` with `loadAddon`/`fit`/`dispose`), and `window.electron.on`/`off`. Assertions:
   - On mount, `electron.on` is called with channel `cyboflow:pty:${runId}` and a handler.
   - Delivering a chunk via the captured handler calls `term.write(chunk)` with the EXACT chunk.
   - `cyboflowStore.streamEvents` is untouched (import the store, assert `getState().streamEvents.length === 0` before and after delivering chunks) — the store-isolation invariant.
   - The `Terminal` is constructed with `disableStdin: true` and `term.onData` is NEVER registered (no input relay at this stage).
   - Unmount calls the cleanup which calls `electron.off` with the SAME channel + handler and `term.dispose()`.
   - Auto-scroll: with `viewportY === baseY` (at bottom) a write calls `term.scrollToBottom()`; with `viewportY < baseY` (scrolled up) it does NOT.
   - No `any` anywhere in the test.

5. **Write `frontend/src/components/cyboflow/__tests__/RunChatView.test.tsx`.** Mock `activeRunsStore` (`useActiveRunsStore`) so `runsByProject` contains a row for the test `runId` with a controllable `substrate`, mock `trpc.cyboflow.runs.listUnifiedMessages.query` to resolve a small `UnifiedMessage[]`, and mock the heavy children (`InteractiveTerminalView`, `ChatTranscript`, `ChatInput`, `PendingApprovalsForRun`, `PromptNavigation`) as testid stubs. Two branches:
   - `substrate: 'interactive'` → `InteractiveTerminalView` stub is present; `PromptNavigation` stub is ABSENT; `ChatTranscript` stub is ABSENT; `ChatInput` + `PendingApprovalsForRun` stubs are PRESENT.
   - `substrate: 'sdk'` (and a `substrate: undefined` case) → `ChatTranscript` stub PRESENT; `PromptNavigation` stub PRESENT; `InteractiveTerminalView` stub ABSENT; `ChatInput` + `PendingApprovalsForRun` PRESENT.
   - No `any` anywhere in the test.

6. **Run the gates.** Run the no-`any` grep over `files_owned`, then `pnpm --filter frontend test InteractiveTerminalView` and `pnpm --filter frontend test RunChatView`, then `pnpm typecheck && pnpm lint`, then the full `pnpm test:unit` (exit 0). If a `better-sqlite3` NODE_MODULE_VERSION error surfaces in the main vitest leg, run `pnpm rebuild better-sqlite3` first per CLAUDE.md. Commit atomically (one commit for this task) once green — do not push.

## Acceptance Criteria notes

- **Store-isolation is the load-bearing claim.** The whole point of the dedicated `cyboflow:pty:<runId>` channel (TASK-814) is that raw bytes never enter the structured pipeline. The `InteractiveTerminalView` test asserting `cyboflowStore.streamEvents` stays empty while `term.write` receives the chunks is the renderer-side proof of Q3 panel-preservation. If a future edit routes PTY bytes through the store, this test fails — keep it.
- **`subscribeToPtyBytes` typing is a deliberate carve-out, not a CLAUDE.md violation.** The onData/AppRouter-inference rule applies to tRPC subscriptions and structured IPC envelopes. The raw-PTY channel is neither — it is a byte transport, correctly typed `string`. Do NOT reuse `StreamEvent` here (that would falsely couple raw bytes to the structured discriminated union) and do NOT declare a local `IPCResponse` for the chunk. The no-`IPCResponse`/no-`(evt: unknown)`-guard greps still apply to every other line of the touched files.
- **Read-only is enforced by absence.** This stage ships `disableStdin: true` and NO `onData` relay precisely so the first-interaction guardrail (TASK-816 warn modal) and the relay transport (TASK-817 `sendTurn`) can be layered on additively without this view ever having been silently interactive. The `grep onData(` returning 0 is the contract that TASK-817 will later (intentionally) flip.
- **Substrate is read, never re-declared.** `RunChatView` consumes `ActiveRunRow.substrate` (AppRouter-inferred via the list query shape, populated by TASK-813). A local `type Substrate = 'sdk' | 'interactive'` in the renderer is a CLAUDE.md violation and fails the inference AC.
- **The 'sdk' branch must be byte-for-byte the prior behavior.** The parity assertion is the `substrate: 'sdk'` RunChatView test rendering `ChatTranscript` + `PromptNavigation` exactly as today. If the sdk branch changes rendering, that is a regression — the swap must be purely additive behind `isInteractive`.

## Out of Scope

- **The raw-PTY BACKEND pipeline** (`pty-output` emit on the second `ptyProcess.onData`, the `SubstrateDispatchFacade` `interactivePtyHandler` fan-in, the `ptyPublisher` + `cyboflow:pty:` `webContents.send`, the preload `startsWith('cyboflow:pty:')` allowlist) — all owned by TASK-814 and consumed read-only here. This task subscribes to the channel TASK-814 created; it does not touch any `main/` file.
- **Two-way interactivity** — keystroke input relay (`term.onData` → `relayInput`), the first-interaction warn modal, and the PTY resize relay (xterm cols/rows → `node-pty resize`). The warn dialog + interactive chrome (INTERACTIVE pill, LIVE PTY bar, reduced-motion) are TASK-816; the `sendTurn` backend relay + composer relay + 'Interact anyway' keystroke relay + resize are TASK-817. Both edit `InteractiveTerminalView.tsx` ADDITIVELY after this task commits (chain 815→816→817) — do NOT pre-build their wiring; ship `disableStdin: true` and no `onData`.
- **The persistence/completion rework** — gating `handleTurnEnd`'s EOF/`/exit` kill behind the persistent flag, the event-driven `restAwaitingReview`, and the explicit-termination spawn-promise resolver (the central completion-model contract) — owned entirely by TASK-818 in `interactiveClaudeManager.ts` / `runExecutor.ts` / `substrateDispatchFacade.ts` / `runs.ts` / `index.ts`. The terminal in this task renders whatever the live PTY emits; it makes no assumption about when the run finalizes. NEVER treat the turn-end marker as the terminal/drained proxy (it fires every turn).
- **Interactive approval-gate wiring** — calling `InteractiveSettingsWriter.write` on spawn and implementing the `denyInFlightShellApprovals`/`removeGeneratedSettings` teardown stubs — owned by TASK-819 (consumes TASK-810's shipped writer/handler/hook; never re-implements them).
- **`RunBottomPane`'s separate 'Terminal' tab placeholder** — the interactive terminal lives ON the Chat tab (inside `RunChatView`), NOT behind the `RunBottomPane` 'terminal' placeholder. Do NOT conflate them.
- **A replay/scrollback buffer for late mount / run reopen** — raw PTY bytes are ephemeral (no persistence; the structured path keeps history via `raw_events`). The live terminal shows only bytes emitted after subscription. A per-run ring buffer is a possible future iteration, not this task.
- **Dynamic-workflow def-driven prompts and per-stage step advancement** — explicitly deferred to a separate follow-up iteration, NOT in IDEA-030.
- **A `pnpm test:e2e` gate** — per CLAUDE.md the verifier gate is `pnpm test:unit` only; `test:e2e` is non-functional in headless verifier environments.
