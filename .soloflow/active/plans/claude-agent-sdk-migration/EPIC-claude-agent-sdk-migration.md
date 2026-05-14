---
epic: claude-agent-sdk-migration
created: 2026-05-14T00:00:00Z
status: active
originating_ideas: [IDEA-014]
---

# Claude Agent SDK Migration

## Objective

Replace the `claude -p --output-format stream-json` subprocess substrate with the `@anthropic-ai/claude-agent-sdk` Node.js library as the runtime for cyboflow's Claude panel. Product surfaces (review queue, panels, worktrees, runs, settings, renderer subscribers) do NOT change — what changes is the plumbing between cyboflow's main process and the Claude agent loop.

Driven by the 2026-06-15 Anthropic billing change (see memory note `anthropic_sdk_billing_change_june_2026.md` and IDEA-014). Post-cutover `-p` and the SDK draw from the same Agent SDK credit bucket, so this is purely an engineering-robustness play with zero economic delta. A parity spike against `docs.claude.com/en/api/agent-sdk` verified direct SDK equivalents for all 8 capabilities cyboflow currently uses, with three strict improvements:

1. In-process permission gating via `hooks.PreToolUse` — no MCP bridge process, no Unix socket round-trip.
2. Inline `mcpServers` object literal — no `.mcp.json` temp file.
3. Proper `systemPrompt.append` — no inline string concatenation hack.

Target SDK version: `@anthropic-ai/claude-agent-sdk` ≥ 0.2.x (current at parity-spike time was 0.2.141).

## Portability invariant

A future pivot to interactive `claude` (IDEA-013, contingent on post-launch unit economics) needs the **same orchestrator-side tool-approval protocol**, just over a different transport (shell hook in `.claude/settings.json` posting to a Unix socket, instead of an in-process callback). To keep that pivot cheap, this EPIC defines an `ApprovalRouter` interface (`shared/types/approval.ts`) with strict `ApprovalRequest` / `ApprovalResponse` schemas. `permissionManager.ts` and the review-queue UI consume ONLY this interface, never the substrate. The SDK `PreToolUse` callback is one transport adapter; the legacy MCP bridge (being deleted by this EPIC) was another; a future shell hook would be a third, dropping into the same router with zero downstream churn.

Other substrate-portable surfaces preserved verbatim — must survive this migration intact and remain usable under a future interactive pivot:

- `AbstractCliManager` and the `node-pty` infrastructure (the terminal panel still uses it; a future interactive pivot would reuse it for the Claude panel as well — `docs/cyboflow_system_design.md:64` already calls this out as an extension surface).
- `eventRouter.ts`, `messageProjection.ts`, `rawEventsSink.ts`, `typedEventNarrowing.ts` — typed-event consumers, rewired to a new source.
- The discriminated union in `shared/types/claudeStream.ts` and `main/src/services/streamParser/schemas.ts`. SDK `stream_event` / `system` / `assistant` / `user` / `result` shapes are identical (or near-identical, with first-class TypeScript types from `@anthropic-ai/sdk`) to today's `--include-partial-messages` output — the union retargets without redesign. The typed-stream-event-schema epic's intellectual output transfers; only the byte-stream validation layer (Zod schemas guarding JSON.parse output, JSON-line fixtures) retires.
- `enhancePromptForStructuredCommit` as a pure string-producing function. Under SDK it feeds `systemPrompt.append`; under interactive it would feed a slash-command or TUI typed-input. Stays decoupled from the emission mechanism.

## Scope

### In scope

- Add `@anthropic-ai/claude-agent-sdk` (≥ 0.2.x) as a direct dependency in `main/package.json`.
- Define `ApprovalRouter` interface and `ApprovalRequest` / `ApprovalResponse` schemas in a new `shared/types/approval.ts`. Refactor `permissionManager.ts` to consume only this interface. This step runs BEFORE any substrate work so the contract is locked first.
- Rewrite `main/src/services/panels/claude/claudeCodeManager.ts` from PTY-subprocess manager to SDK `query()` client. Map the 8 parity-verified options:
  - `cwd: worktreePath` (per-run isolation).
  - `model: <selected>` with omit-for-auto semantics (preserves today's `--model auto` default).
  - `mcpServers: { ... }` as inline object literals (per-server `env` injection for `CYBOFLOW_RUN_ID` etc.).
  - `systemPrompt: { type: "preset", preset: "claude_code", append: <enhanced-prompt-string> }`. The explicit `preset: "claude_code"` is non-negotiable — SDK v0.1.0+ defaults to a minimal generic prompt otherwise.
  - `includePartialMessages: true` (preserves UI typing-indicator / live-token-stream behavior).
  - `resume: <session_id>` for continuation; `session_id` captured from the `system/init` message and persisted via the existing `sessionManager.getPanelClaudeSessionId` path.
  - `hooks.PreToolUse` routed through `ApprovalRouter` to the existing review queue. The SDK's `defer` permission decision maps to the queue's "pending human" path.
  - `env: { ... }` for any per-invocation environment vars not scoped to a specific MCP server.
- Retarget the discriminated union and Zod schemas (`shared/types/claudeStream.ts`, `main/src/services/streamParser/schemas.ts`) to SDK message shapes. The schemas stay typed-narrow (no Zod runtime validation needed for in-process events — TypeScript types from the SDK are authoritative); keep the file for narrowing helpers if convenient.
- Replace the completion-detection watchdog with SDK promise resolution + the `result` message. Preserve the upstream "run completed" event contract so the orchestrator's run-lifecycle and watchdog tests don't churn.
- Update fixture-based tests where they have substrate-independent value (event routing, message projection) to use SDK-mock fixtures. Retire tests whose sole purpose was JSON parsing or line buffering.

### Deletions (this epic)

- `main/src/services/streamParser/lineBufferer.ts` and `__tests__/lineBufferer.test.ts`.
- `main/src/services/streamParser/jsonParser.ts` and `__tests__/jsonParser.test.ts`.
- `main/src/services/streamParser/streamParser.ts` end-to-end glue and `__tests__/streamParser.test.ts`.
- `main/src/services/streamParser/completionDetector.ts` and `__tests__/completionDetector.test.ts`.
- The `__fixtures__/*.json` corpus and the fixture-driven `__tests__/schemas.test.ts` validation pattern. (The `schemas.ts` file itself stays, retargeted; what retires is the byte-stream parse-and-validate test layer.)
- `main/build-cyboflow-permission-bridge.js` and the bridge-spawn path in `claudeCodeManager.ts`.
- The `--permission-prompt-tool`, `--mcp-config`, `-p`, `--output-format`, `--verbose`, `--include-partial-messages`, and `--resume` argv-construction code in `claudeCodeManager.ts:buildCommandArgs` (currently lines 100-185).
- The PATH-discovery + `claudeExecutablePath` config path in `claudeCodeManager.ts:187-200` (no CLI binary required under SDK).

### Out of scope

- Interactive-shell pivot (IDEA-013) — separate EPIC, gated on post-launch unit economics. This EPIC preserves the portability hooks but does not implement the interactive transport.
- Multi-provider support (IDEA-015) — separate EPIC, sequences after this one. The `ApprovalRouter` interface from this EPIC is the foundation per-provider permission gates will plug into.
- Changes to `AbstractCliManager`, `node-pty`, or the terminal panel — those stay.
- Changes to the review queue UI, tRPC routes, run/session DB schema, worktree manager, settings, panel persistence, or renderer subscribers — all substrate-independent, all stay.
- Adopting the SDK's native `WorktreeCreate` / `WorktreeRemove` hooks (flagged as bonus in the parity spike). cyboflow's worktree manager is independent; that integration is a follow-up EPIC.
- Adopting `canUseTool` as an alternative simpler-than-hooks permission predicate (also flagged in the parity spike). Stick with `PreToolUse` hooks for richer audit trail and `defer` semantics.

## Suggested task skeleton (for refinement)

Indicative ordering — the task-decomposer will set final shape. Listed to surface dependencies and de-risk paths.

1. **SDK install + smoke probe.** Add dep, write a 30-line script that calls `query()` with a hardcoded prompt and prints events. De-risks everything downstream before touching cyboflow internals.
2. **Define `ApprovalRouter` interface.** `shared/types/approval.ts` + refactor `permissionManager.ts` to consume only the interface. MCP bridge still wired, just routed through the new interface. Zero behavior change at this step.
3. **Retarget typed event union to SDK shape.** Update `shared/types/claudeStream.ts` and `schemas.ts` to reflect SDK message types. Don't delete old fixtures yet — `-p` path still operational.
4. **Rewrite `claudeCodeManager.ts` for SDK.** Swap PTY spawn for `query()`. Wire all 8 options. Capture `session_id` from `system/init`. Wire `PreToolUse` through `ApprovalRouter`. At this step `-p` is dead and SDK is live.
5. **Delete the MCP permission bridge.** Remove `build-cyboflow-permission-bridge.js` and the bridge-spawn path. ApprovalRouter is the only path now.
6. **Delete stream-json parser plumbing.** `lineBufferer`, `jsonParser`, `streamParser` end-to-end glue, JSON-line fixtures, JSON-validation tests. Keep `eventRouter`, `messageProjection`, `rawEventsSink`, `typedEventNarrowing`.
7. **Replace completion detection.** Promise resolution + `result` message replaces the watchdog gate. Preserve upstream event contract.
8. **Test migration.** Substrate-independent tests adapt to SDK mocks; substrate-specific tests retire.
9. **Integration smoke + visual verify.** End-to-end: launch panel, send prompt, intercept tool, approve from review queue, resume across restart, model selection. Confirm `pnpm dev` works with `claude` removed from PATH.

## Success signal

1. `pnpm dev` launches the app with `@anthropic-ai/claude-agent-sdk` as the substrate. A new Claude panel can be created, prompted, and streams responses end-to-end including partial-message events.
2. A tool call is intercepted by the SDK `PreToolUse` hook, routed through `ApprovalRouter` into the existing review queue, and is approvable/deniable from the UI without changes to the review-queue UI code.
3. Session resume across a panel restart works: kill the panel mid-conversation, restart, the next message continues the prior session via `options.resume`.
4. `pnpm dev` works with `claude` removed from `$PATH` — no CLI binary dependency.
5. `permissionManager.ts` has zero imports of MCP-bridge code; the bridge process spawn is gone; `build-cyboflow-permission-bridge.js` is deleted.
6. `streamParser/lineBufferer.ts`, `jsonParser.ts`, `streamParser.ts`, `completionDetector.ts`, and the stream-json fixture corpus are deleted. `eventRouter.ts`, `messageProjection.ts`, `rawEventsSink.ts`, `typedEventNarrowing.ts` survive and consume SDK-shaped typed events through the retargeted discriminated union.
7. `ApprovalRouter` interface is defined and `permissionManager.ts` consumes only this interface — confirmed by grep showing no SDK/MCP-specific types leak into `permissionManager.ts` or the review-queue UI.
8. `pnpm typecheck`, `pnpm lint`, and `pnpm test` are green.
9. The review queue UI, panel UI, and run lifecycle behave identically to pre-migration from a user's perspective.
