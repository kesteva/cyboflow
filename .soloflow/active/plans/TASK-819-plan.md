---
id: TASK-819
idea: IDEA-030
status: ready
created: 2026-06-02T00:00:00Z
source: IDEA-030
epic: interactive-persistent-terminal
files_owned:
  - main/src/services/panels/claude/interactiveClaudeManager.ts
  - main/src/services/panels/claude/__tests__/interactiveClaudeManager.test.ts
  - main/src/index.ts
  - main/src/orchestrator/mcpServer/orchSocketServer.ts
files_readonly:
  - main/src/services/panels/claude/interactiveSettingsWriter.ts
  - main/src/orchestrator/shellHooks/preToolUseShellHook.ts
  - main/src/orchestrator/mcpServer/mcpQueryHandler.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
acceptance_criteria:
  - criterion: "On spawn (spawnCliProcess), InteractiveSettingsWriter.write is called once with the worktree path and the manager's logger PASSED, installing the PreToolUse '*' shell hook into <worktree>/.claude/settings.json so the --settings path emitted by buildCommandArgs (interactiveClaudeManager.ts:291-296) is no longer dangling. The write is gated by permissionMode: when permissionMode === 'ignore' the writer SKIPS (returns null) — consuming the writer's own opt-out branch (interactiveSettingsWriter.ts:148), NOT a second gate in the manager."
    verification: "grep -n 'new InteractiveSettingsWriter\\|\\.write(' main/src/services/panels/claude/interactiveClaudeManager.ts shows the writer construction (logger passed) and the .write(worktreePath, { permissionMode }) call inside spawnCliProcess; interactiveClaudeManager.test.ts asserts write() is invoked on spawn with the worktree path and is NOT invoked when permissionMode==='ignore'."
  - criterion: "denyInFlightShellApprovals(runId) denies + closes any in-flight shell-approval sockets for the runId on teardown by delegating to the orchestrator handler's shipped cancelInFlightShellApprovals(runId) (mcpQueryHandler.ts:519) via an injected canceller seam — BEFORE the PTY is killed and BEFORE ApprovalRouter.clearPendingForRun runs, so the blocked hook subprocess unblocks with a deny rather than leaking. No-op safe when no canceller is wired (quick sessions / boot order) and when nothing is in flight."
    verification: "grep -n 'denyInFlightShellApprovals\\|shellApprovalCanceller\\|setShellApprovalCanceller' main/src/services/panels/claude/interactiveClaudeManager.ts shows the canceller seam invoked with runId; interactiveClaudeManager.test.ts asserts teardownRun (via cleanupCliResources / abort) calls the injected canceller with the run's runId and that the call is ordered before clearPendingForRun."
  - criterion: "removeGeneratedSettings(panelId) removes the generated PreToolUse '*' hook entry on teardown by calling InteractiveSettingsWriter.remove(worktreePath) for the run's worktree, leaving user .claude/settings.json keys intact (the writer's merge-safe remove, interactiveSettingsWriter.ts:192). No-op safe when no settings file exists or no cyboflow entry is present."
    verification: "grep -n 'removeGeneratedSettings\\|\\.remove(' main/src/services/panels/claude/interactiveClaudeManager.ts shows the remove call resolving the worktree from the run record; interactiveClaudeManager.test.ts asserts the generated hook entry is gone from .claude/settings.json after teardownRun (write-then-teardown round-trip on a temp worktree)."
  - criterion: "The deny-on-teardown seam is WIRED at boot, not left dead: OrchSocketServer exposes a public cancelInFlightShellApprovals(runId): number that delegates to its private handler's shipped cancelInFlightShellApprovals (mcpQueryHandler.ts:519), and index.ts calls interactiveCliManager.setShellApprovalCanceller((runId) => orchSocketServer.cancelInFlightShellApprovals(runId)) at boot near the existing interactive-manager wiring (setOrchSocketPath, index.ts:768-769). Without this the manager-side denyInFlightShellApprovals canceller is null and the deny ships as a production no-op."
    verification: "grep -n 'cancelInFlightShellApprovals' main/src/orchestrator/mcpServer/orchSocketServer.ts shows the public method delegating to this.handler.cancelInFlightShellApprovals(runId); grep -n 'setShellApprovalCanceller' main/src/index.ts shows the boot wiring passing (runId) => orchSocketServer.cancelInFlightShellApprovals(runId)."
  - criterion: "TASK-810's parts are CONSUMED, not re-implemented: interactiveSettingsWriter.ts, preToolUseShellHook.ts, and mcpQueryHandler.ts are UNTOUCHED in this task's diff. The manager imports InteractiveSettingsWriter and delegates socket-deny to the handler's cancelInFlightShellApprovals — no copy of the writer body, the hook flow, or the in-flight-socket registry is added to the manager."
    verification: "git diff --stat shows 0 changed lines in main/src/services/panels/claude/interactiveSettingsWriter.ts, main/src/orchestrator/shellHooks/preToolUseShellHook.ts, and main/src/orchestrator/mcpServer/mcpQueryHandler.ts; grep -n 'class InteractiveSettingsWriter\\|registerInFlightShellApproval\\|runShellHook' main/src/services/panels/claude/interactiveClaudeManager.ts returns 0 (no re-implementation)."
  - criterion: "TASK-808's teardownRun ordering and TASK-814/818 additive wiring are PRESERVED, not removed: the new write()/remove()/deny() calls slot into the EXISTING spawn preamble and teardownRun body without deleting the pty-output emit (TASK-814), the persistent turn-end gating (TASK-818), or the existing TranscriptSource.stop / ApprovalRouter+QuestionRouter clearPendingForRun / pipeline dispose. The SDK substrate (ClaudeCodeManager) is byte-identical — none of this code runs for SDK runs."
    verification: "git diff main/src/services/panels/claude/claudeCodeManager.ts shows 0 changed lines; the existing interactiveClaudeManager.test.ts cases (output-shape parity, raw_events cardinality, cleanup, no-leak) still pass under pnpm --filter main test interactiveClaudeManager; grep -n 'pty-output\\|turnEnded' main/src/services/panels/claude/interactiveClaudeManager.ts confirms the prior tasks' wiring is intact."
  - criterion: "The optional logger? is PASSED to InteractiveSettingsWriter (CLAUDE.md optional-logger rule: passing it enables write/skip/remove diagnostics; omitting it silently no-ops observability). The writer accepts LoggerLike; adapt the manager's Logger surface to LoggerLike at the call site if the surface differs."
    verification: "grep -n 'new InteractiveSettingsWriter(' main/src/services/panels/claude/interactiveClaudeManager.ts shows the logger argument supplied (not new InteractiveSettingsWriter() with no args); pnpm typecheck exits 0 confirming the LoggerLike adaptation compiles."
  - criterion: "No use of the `any` type in any file this task owns (the canceller seam is typed as (runId: string) => number, the writer is imported with its exported types, and tRPC/IPC are untouched here)."
    verification: "grep -nE ':\\s*any(\\b|\\[)|<any>|as any' main/src/services/panels/claude/interactiveClaudeManager.ts main/src/services/panels/claude/__tests__/interactiveClaudeManager.test.ts returns 0 matches."
  - criterion: "The touched code type-checks and lints clean."
    verification: "pnpm typecheck && pnpm lint exit 0"
  - criterion: "pnpm test:unit exits 0 (one-shot vitest run; NEVER test:e2e), with interactiveClaudeManager.test.ts included and green."
    verification: "Run pnpm test:unit; exit code 0. If better-sqlite3 NODE_MODULE_VERSION errors appear, run pnpm rebuild better-sqlite3 per CLAUDE.md before the main vitest run."
depends_on: [TASK-818]
estimated_complexity: M
test_strategy:
  needed: true
  justification: "This slice closes the interactive safety contract: tool calls in a live interactive REPL must actually pause for human review, and a torn-down run must not leave a blocked hook subprocess hanging on a held-open socket. Both are correctness/safety claims (a dangling --settings path means NO gating; a leaked in-flight socket means a stuck PTY) that MUST be locked by tests against the shipped TASK-810 surface, not just wired. The existing interactiveClaudeManager.test.ts (spawn + teardown harness with a FakePty, FakeTranscriptSource, in-memory DB) anchors the new cases; the writer/handler are real (consumed), so the tests assert the manager's CALL into them on the real spawn/teardown paths plus the permissionMode='ignore' skip and the canceller ordering."
  targets:
    - behavior: "spawnCliProcess calls InteractiveSettingsWriter.write(worktreePath, { permissionMode }) once with the logger passed, installing the PreToolUse '*' hook into <worktree>/.claude/settings.json; permissionMode==='ignore' produces no hook write (writer returns null)."
      test_file: "main/src/services/panels/claude/__tests__/interactiveClaudeManager.test.ts"
      type: unit
    - behavior: "teardownRun calls the injected shell-approval canceller with the run's runId BEFORE ApprovalRouter.clearPendingForRun, denying/closing in-flight shell-approval sockets; safe no-op when no canceller is wired."
      test_file: "main/src/services/panels/claude/__tests__/interactiveClaudeManager.test.ts"
      type: unit
    - behavior: "teardownRun calls InteractiveSettingsWriter.remove(worktreePath), removing the generated '*' hook entry while preserving user keys (write-then-teardown round-trip on a temp worktree)."
      test_file: "main/src/services/panels/claude/__tests__/interactiveClaudeManager.test.ts"
      type: unit
    - behavior: "TASK-808/814/818 wiring is preserved: prior cleanup (TranscriptSource.stop, router clearPendingForRun, pipeline dispose) and the pty-output / persistent turn-end paths still behave as before; SDK manager untouched."
      test_file: "main/src/services/panels/claude/__tests__/interactiveClaudeManager.test.ts"
      type: unit
---

# Interactive approval-gate wiring: call InteractiveSettingsWriter.write on spawn + implement the two teardown stubs

## Objective

Finish the MANAGER-SIDE wiring of the interactive PreToolUse shell-approval gate so tool calls in a live interactive `claude --resume` session actually pause for human review. TASK-810 already shipped every reusable part — `InteractiveSettingsWriter` (the merge-safe `.claude/settings.json` writer/remover), `preToolUseShellHook.ts` (the standalone PreToolUse subprocess that blocks on the orchestrator socket for the full human-decision window), and `mcpQueryHandler.handleShellApprovalRequest` + `cancelInFlightShellApprovals` (the orchestrator-side router round-trip and the deny-and-close-on-cancel twin). But the manager seams that activate them are still dead: `InteractiveSettingsWriter.write` is NEVER called on spawn (so the `--settings <path>` flag `buildCommandArgs` emits at `interactiveClaudeManager.ts:291-296` points at a non-existent file → NO hook → NO gating), and the two teardown stubs `denyInFlightShellApprovals` (`:714`) and `removeGeneratedSettings` (`:722`) are documented no-ops.

This task ONLY touches the manager and its test (`files_owned`). It (1) calls `InteractiveSettingsWriter.write` on spawn (with the logger passed and gated by the writer's own `permissionMode==='ignore'` skip), (2) implements `denyInFlightShellApprovals` by delegating to the handler's shipped `cancelInFlightShellApprovals(runId)` through an injected canceller seam, and (3) implements `removeGeneratedSettings` by calling `InteractiveSettingsWriter.remove(worktreePath)`. Because TASK-818 made the interactive session a TRUE persistent multi-turn REPL that stays alive across approval gates, the socket-blocking approval design is now CORRECT — approvals interleave turn-by-turn without a turn-end/approval race, which is exactly the precondition the shipped handler assumed. The SDK substrate is byte-identical (none of this code runs for SDK runs), and all prior-task wiring in this file (the TASK-814 `pty-output` emit, the TASK-818 persistent turn-end gating) is preserved ADDITIVELY.

## Implementation Steps

1. **Import the writer and resolve its path target.** Add `import { InteractiveSettingsWriter } from './interactiveSettingsWriter';` at the top of `interactiveClaudeManager.ts` (alongside the existing transcript imports, ~line 13-16). The writer's `write()`/`remove()` operate on `<worktreePath>/.claude/settings.json` (interactiveSettingsWriter.ts:231) — note this is a DIFFERENT path from the `--settings` flag the manager currently emits, which points at `<worktree>/.cyboflow/interactive-settings.json` (buildCommandArgs `:291`). The `--settings` flag and the hook file MUST agree. RECONCILE in step 2: the writer is the authority for the hook file location; `claude` reads `.claude/settings.json` by default, and the writer installs the `'*'` PreToolUse hook there. Do NOT edit the writer (readonly). The minimal, in-bounds fix is to keep the writer's `.claude/settings.json` target and DROP the dangling `--settings <.cyboflow/interactive-settings.json>` flag from `buildCommandArgs` (it pointed at a file nothing ever wrote — the original TASK-808 comment at `:289-290` explicitly says "the actual settings+hook file is GENERATED by S5/TASK-810"). Leave `--mcp-config` untouched. This removes the dangling-flag failure mode and lets `claude` pick up the writer-installed hook from its default settings path.

2. **Construct the writer once, logger PASSED.** In the constructor (after `super(...)`, near the `this.narrowing = new TypedEventNarrowing(this.logger)` line `:191`), add `this.settingsWriter = new InteractiveSettingsWriter(this.logger)` and declare `private readonly settingsWriter: InteractiveSettingsWriter;`. The writer's constructor takes `logger?: LoggerLike` (interactiveSettingsWriter.ts:140). The manager's `this.logger` is `Logger | undefined`; if its surface does not structurally satisfy `LoggerLike`, adapt at the call site (e.g. pass `{ debug: (m, meta) => this.logger?.debug?.(m) }`-style shim) rather than omitting it — omitting silently no-ops the write/skip/remove diagnostics (CLAUDE.md optional-logger rule). Prefer passing `this.logger` directly if it already satisfies `LoggerLike`; verify with `pnpm typecheck`.

3. **Call `write()` on spawn.** In `spawnCliProcess`, AFTER the availability probe and BEFORE/AROUND the `spawnPtyProcess` call (the natural seam is right before `const args = this.buildCommandArgs(...)` at `:393`, so the hook file exists before `claude` launches), call:
   ```
   this.settingsWriter.write(worktreePath, { permissionMode: options.permissionMode });
   ```
   The writer SKIPS internally when `permissionMode` is `'ignore'`/`'dontAsk'` (interactiveSettingsWriter.ts:148) and returns `null` — do NOT add a second gate in the manager (consume the writer's branch). This mirrors the per-option parity-table decision documented at `interactiveClaudeManager.ts:56-59` (`permissionMode 'ignore' SKIPS writing the gating shell hook`). The write is idempotent (the writer drops any stale cyboflow entry before re-adding) so a respawn is safe. No `await` needed (the writer is synchronous fs).

4. **Implement `denyInFlightShellApprovals` via an injected canceller seam.** The orchestrator-side deny-and-close logic is already shipped as `mcpQueryHandler.cancelInFlightShellApprovals(runId): number` (mcpQueryHandler.ts:519) and is documented there as "The interactive manager's cleanupCliResources (TASK-808) calls this BEFORE killing the PTY so the blocked hook subprocess unblocks". The handler instance lives inside `OrchSocketServer` (orchSocketServer.ts:90, `private readonly handler`) and is NOT reachable from the manager today; `index.ts` (OWNED by this task — see step 6) is where the `OrchSocketServer`/handler is constructed and where `interactiveCliManager.setOrchSocketPath(socketPath)` is already called (index.ts:768-769). Add an injection seam on the manager, mirroring `setOrchSocketPath`:
   ```
   private shellApprovalCanceller: ((runId: string) => number) | null = null;
   setShellApprovalCanceller(fn: (runId: string) => number): void { this.shellApprovalCanceller = fn; }
   ```
   Then implement the stub at `:714`:
   ```
   private denyInFlightShellApprovals(runId: string): void {
     try { this.shellApprovalCanceller?.(runId); }
     catch (err) { this.logger?.warn(`[InteractiveClaudeManager] cancel in-flight shell approvals failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`); }
   }
   ```
   It is already invoked from `teardownRun` at `:692` with `runId`, and CRITICALLY it runs BEFORE `ApprovalRouter.getInstance().clearPendingForRun(runId)` at `:687` only if you keep the existing call order — re-verify the order: the handler's deny must fire so the held-open socket gets a real deny verdict, THEN `clearPendingForRun` settles the DB row (the handler comment at mcpQueryHandler.ts:507-511 spells out this exact ordering). The current teardownRun calls `clearPendingForRun` at `:687` BEFORE `denyInFlightShellApprovals` at `:692` — MOVE the `denyInFlightShellApprovals(runId)` call ABOVE the two `clearPendingForRun` calls so the socket deny precedes the router DB settle (additive reorder within the owned method; do not remove either call). The seam is `null`-safe so quick sessions / a boot before the canceller is wired no-op cleanly. The actual `index.ts` + `orchSocketServer.ts` boot wiring (`interactiveCliManager.setShellApprovalCanceller((runId) => orchSocketServer.cancelInFlightShellApprovals(runId))`, which also requires `OrchSocketServer` to expose a public `cancelInFlightShellApprovals` delegating to its private handler) is OWNED by this task and lands in step 6 — without it the canceller is never set and the deny ships as a production no-op. The unit test injects the canceller directly via `setShellApprovalCanceller` so the manager-side behavior is covered independently of the boot wiring.

5. **Implement `removeGeneratedSettings` via the writer's `remove`.** Implement the stub at `:722` to strip the generated hook entry on teardown:
   ```
   private removeGeneratedSettings(panelId: string): void {
     const run = this.interactiveRuns.get(panelId);
     const worktreePath = run?.worktreePath;
     if (!worktreePath) return;
     try { this.settingsWriter.remove(worktreePath); }
     catch (err) { this.logger?.warn(`[InteractiveClaudeManager] remove generated settings failed for panel ${panelId}: ${err instanceof Error ? err.message : String(err)}`); }
   }
   ```
   `remove()` is merge-safe (interactiveSettingsWriter.ts:192): it strips ONLY the cyboflow `'*'` entry (identified by the hook-script path), prunes an empty `PreToolUse` container, and preserves all user keys; it is a no-op when the file is absent or carries no cyboflow entry. It is invoked from `teardownRun` at `:696` with `panelId`; resolve the worktree from the `interactiveRuns` record (the run is still present at `:696` because `this.interactiveRuns.delete(panelId)` runs last at `:706`). Keep the existing call site.

6. **Wire the deny-on-teardown canceller at boot (`orchSocketServer.ts` + `index.ts`, both OWNED by this task).** The manager's `setShellApprovalCanceller` seam (step 4) is dead until something injects the canceller — TASK-818 does not wire it, so this task owns the boot wiring (it depends_on TASK-818 and edits `index.ts` additively after it). Two ADDITIVE edits:
   - **`orchSocketServer.ts`:** add a public `cancelInFlightShellApprovals(runId: string): number` method that delegates to the private handler's shipped twin: `return this.handler.cancelInFlightShellApprovals(runId);` (the handler at `mcpQueryHandler.ts:519` is reachable via `this.handler` at `orchSocketServer.ts:90`). This exposes the deny-and-close affordance TASK-810 shipped on the handler. Do NOT re-implement the deny logic — delegate only.
   - **`index.ts`:** at boot, near the existing `interactiveCliManager.setOrchSocketPath(socketPath)` wiring (`index.ts:768-769`) where both the `OrchSocketServer` and the interactive manager are in scope, add:
     ```
     interactiveCliManager.setShellApprovalCanceller((runId) => orchSocketServer.cancelInFlightShellApprovals(runId));
     ```
   This is purely additive — do NOT remove the existing `setOrchSocketPath` call or any TASK-818 explicit-termination wiring already in this block. The grep ACs assert both halves exist.

7. **Preserve all prior-task wiring (additive only).** Do NOT remove or reorder the TASK-814 second `ptyProcess.onData` `pty-output` emit (after `setupProcessHandlers`, ~`:454`), the TASK-818 persistent turn-end gating / re-armable `turnEnded` flag and turn-end-event forwarding, or the existing teardown body (`TranscriptSource.stop` `:677`, the `QuestionRouter.clearPendingForRun` `:688`, pipeline `sink.dispose`/`router.clearRun` `:701-702`). The ONLY structural change to `teardownRun` is moving `denyInFlightShellApprovals(runId)` above the `clearPendingForRun` pair (step 4). All other edits are new method bodies + a constructor field + a spawn-time `write()` call. `parseCliOutput` still returns `[]`; the base PTY machinery stays inherited and unredeclared.

8. **Extend `interactiveClaudeManager.test.ts`** (mirror the existing FakePty / FakeTranscriptSource / in-memory-DB harness, lines 22-120). Add cases:
   - **write-on-spawn:** spy `InteractiveSettingsWriter.prototype.write` (or assert via a temp worktree that `<worktree>/.claude/settings.json` gains the `'*'` PreToolUse entry after spawn); assert it is called once with the worktree path. Use a real `os.tmpdir()` worktree so the writer's fs round-trip is exercised, OR a `vi.spyOn` on the prototype if avoiding fs. Assert the logger was passed to the writer constructor (spy the constructor or assert a debug log fired).
   - **ignore-mode skip:** spawn with `permissionMode: 'ignore'`; assert NO `'*'` entry is written (writer returns `null`) — proving the writer's opt-out branch is consumed, not a manager gate.
   - **canceller on teardown:** inject `manager.setShellApprovalCanceller(spy)`; drive a spawn then `cleanupCliResources(sessionId)` (or `killProcess`); assert the spy was called once with the run's `runId`. Assert ordering: stub `ApprovalRouter.getInstance().clearPendingForRun` and assert the canceller fired BEFORE it (record call order). Add a no-canceller case asserting teardown does not throw when the seam is unset.
   - **remove on teardown:** write a settings file (via spawn), then teardown, then assert the `'*'` cyboflow entry is gone from `<worktree>/.claude/settings.json` while a pre-seeded user key (e.g. `permissions.allow`) survives.
   - Keep the existing parity / raw_events / cleanup / no-leak cases passing (regression guard for steps 1-7).

9. **Run the gates.** `grep` the no-`any` AC over both owned files; `git diff --stat` the three TASK-810 readonly files to prove 0 changed lines (consume-not-reimplement AC) and `claudeCodeManager.ts` to prove SDK byte-identity; then `pnpm typecheck && pnpm lint` (clean) and `pnpm test:unit` (exit 0). If a `better-sqlite3` NODE_MODULE_VERSION error appears, run `pnpm rebuild better-sqlite3` per CLAUDE.md before the main vitest run.

## Acceptance Criteria notes

- **The dangling `--settings` flag is the live bug this task closes.** `buildCommandArgs` emits `--settings <worktree>/.cyboflow/interactive-settings.json` but nothing ever wrote that file, AND the writer installs the hook into `<worktree>/.claude/settings.json` (its own fixed target). Pointing `--settings` at an empty/absent path while the real hook lives elsewhere means `claude` loads NO PreToolUse hook → tool calls never gate. Step 1's reconciliation (drop the dangling flag, let `claude` read its default `.claude/settings.json` that the writer populates) is what makes gating actually fire. If a future iteration wants an explicit `--settings` path, it must point at the writer's target — but do NOT change the writer (readonly).
- **permissionMode gating is the writer's job, not the manager's.** The manager passes `permissionMode` through to `write()`; the writer's `ignore`/`dontAsk` skip (interactiveSettingsWriter.ts:148) is the single source of truth. Re-implementing the gate in the manager would duplicate logic and risk drift — the test asserts the SKIP happens via the writer, not a manager branch.
- **Teardown ordering is a correctness invariant, not cosmetic.** The handler's `cancelInFlightShellApprovals` writes a real DENY verdict on each held-open socket so the blocked hook subprocess (and thus the blocked PTY) unblocks; `ApprovalRouter.clearPendingForRun` deliberately does NOT touch the socket (correct for the in-process SDK transport, WRONG for the shell transport — mcpQueryHandler.ts:505-511). Deny MUST precede clear, else the socket can be orphaned mid-teardown. The test records call order to lock this.
- **TASK-818 is the precondition that makes this safe.** Before TASK-818 the REPL died at the first turn-end (the old `handleTurnEnd` wrote EOF+`/exit`), so an approval gate opening on a turn that is about to be killed was a race. With the persistent session (REPL alive across gates), the socket-blocking approval interleaves cleanly turn-by-turn — which is the model the shipped handler/hook already assume. This task does not re-litigate that; it consumes the now-correct precondition.
- **The canceller seam decouples manager behavior from boot wiring, and this task owns BOTH.** Reaching `cancelInFlightShellApprovals` requires the handler instance, which lives in `OrchSocketServer`. The injected `setShellApprovalCanceller` setter (manager-owned) lets the unit test cover the manager-side behavior in full via direct injection; the actual `index.ts` + `orchSocketServer.ts` boot wiring (step 6) is OWNED by this task — it depends_on TASK-818 and edits `index.ts` additively after it, exposing `OrchSocketServer.cancelInFlightShellApprovals` and calling `setShellApprovalCanceller` at boot. Without that wiring the canceller stays null and the deny is a production no-op, so it cannot be deferred.
- **No `any`:** the canceller is typed `(runId: string) => number` (matching the handler's return), the writer is imported with its exported types, and nothing here touches tRPC/IPC, so the `IPCResponse<T>` / AppRouter-inference rules do not apply to this task's diff.

## Out of Scope

- Re-implementing ANY of TASK-810's shipped parts: `interactiveSettingsWriter.ts` (the writer/remover body), `preToolUseShellHook.ts` (the PreToolUse subprocess flow), or `mcpQueryHandler.ts` (`handleShellApprovalRequest`, `cancelInFlightShellApprovals`, the in-flight-socket registry). All are consumed read-only; this task's diff leaves them at 0 changed lines.
- (No longer out of scope — moved INTO this task.) The `index.ts` boot wiring of `interactiveCliManager.setShellApprovalCanceller(...)` and the `OrchSocketServer.cancelInFlightShellApprovals` public method exposing the handler's deny to the manager are OWNED by this task (step 6, `index.ts` + `orchSocketServer.ts` in files_owned). They edit those files additively after the upstream TASK-818 boot block. Without them the canceller is never injected and the teardown deny ships dead, so this wiring cannot be deferred.
- The persistence/completion rework (gate turn-end kill, event-driven rest, explicit-termination resolver) — owned by TASK-818, consumed here as the precondition that makes the socket-blocking approval design race-free. Do NOT re-touch `handleTurnEnd`, `wireCompletionExit`, or the turn-end-event forwarding.
- The raw-PTY pipeline (`pty-output` emit, `SubstrateDispatchFacade` fan-in, `ptyPublisher`, the `cyboflow:pty:` channel) — owned by TASK-814; preserved untouched here.
- `sendTurn` live-input / `relayInput` / `relayResize` / the composer relay / the warn dialog — owned by TASK-815/816/817; not touched.
- AskUserQuestion routing on the interactive substrate — intentionally NOT wired (a shell PreToolUse hook has no `updatedInput` channel; native-TUI-only, Probe A2, documented in preToolUseShellHook.ts:30-33). The handler treats an AskUserQuestion shell-approval-request as a normal gate; no QuestionRouter wiring is added here.
- Dynamic-workflow def-driven prompts and per-stage step advancement — deferred to a separate follow-up iteration (NOT in IDEA-030).
- A `pnpm test:e2e` gate — per CLAUDE.md the verifier AC gate is `pnpm test:unit` only.
