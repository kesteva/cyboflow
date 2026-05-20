---
id: IDEA-014
type: FEATURE
status: draft
created: 2026-05-14T00:00:00Z
source: braindump
slices:
  - title: "Migrate from claude -p subprocess to Claude Agent SDK as an embedded library"
    description: "Replace the node-pty-spawned `claude -p` subprocess with @anthropic-ai/claude-agent-sdk calls in-process. Same agent loop, same tools, same model — consumed as a JS API. Wins: native typed events (no line-splitter, no never-throws JSON.parse, no `unknown` catch-all), in-process MCP and permission callbacks (no Unix-socket dance for CYBOFLOW_ORCH_SOCKET), promise-resolved turn completion (no `(child exited) AND (stdout EOF) AND parser queue drained` watchdog), no `claude` install required on the user's machine, no PATH discovery in claudeCodeManager.ts:187-200, no electron:rebuild foot-gun from node-pty on the Claude panel."
    value_statement: "Engineering-robustness play with zero economic delta — post-2026-06-15 the SDK and `-p` share the same Agent SDK credit bucket, so this is a pure 'simpler internals' decision."
open_questions:
  - question: "Is the 'pin the SDK version in cyboflow's bundle' trade-off acceptable, or do users need a 'bring your own claude' affordance (today's `claudeExecutablePath` config in main/src/services/panels/claude/claudeCodeManager.ts:187-200 lets them point at a specific version)?"
    candidates: []
  - question: "Does the SDK expose every capability cyboflow's current `-p` integration depends on — model selection, --resume session continuity, --permission-prompt-tool semantics, MCP server config, system-prompt appending, --include-partial-messages stream variant — or are there CLI-only features that block the migration?"
    candidates: []
  - question: "Sequencing — should this be pursued at all if IDEA-013 (interactive-mode for subscription billing) is the chosen path? IDEA-013 and IDEA-014 are mutually exclusive for the Claude panel; IDEA-014 only makes sense if IDEA-013 is rejected on product grounds, OR as a parallel 'premium tier' that pays the Agent SDK credit for the structured-UI experience."
    candidates: []
assumptions:
  - "@anthropic-ai/claude-agent-sdk is API-compatible with the feature set cyboflow currently uses via `claude -p` (model selection, session resume, MCP, permission gating, system prompts, partial-message streaming)."
  - "The SDK's typed event stream maps cleanly onto the discriminated union from the typed-stream-event-schema epic — the union survives the migration with minor renaming."
  - "Cyboflow shipping with a pinned SDK version (vs. user's `claude` install) is an acceptable product trade-off."
  - "In-process MCP server hosting under Electron's main process works without the Unix-socket isolation the current --permission-prompt-tool flow relies on."
research_recommendation: recommended
research_rationale: "Need to validate SDK feature parity with `claude -p` across the specific surfaces cyboflow uses (Resume, MCP, permission-prompt-tool, partial-message streaming, --include-partial-messages). Also useful: any SDK release-cadence guidance vs. the standalone `claude` CLI."
---

# Migrate from `claude -p` subprocess to Claude Agent SDK as an embedded library

## Context

On 2026-06-15 the SDK and `claude -p` share the same Agent SDK credit bucket — billing-equivalent. So the case for SDK is purely engineering: simpler internals, fewer moving parts, native typed events instead of stream-json-over-PTY. This is NOT a billing-driven migration (see IDEA-013 for the billing-driven alternative).

See memory note `anthropic_sdk_billing_change_june_2026.md` for the full billing context.

## Raw Input

IDEA 2 — Migrate from `claude -p` subprocess to Claude Agent SDK as an embedded library.

Goal: replace the `node-pty`-spawned `claude -p` subprocess with `@anthropic-ai/claude-agent-sdk` calls in-process. Same agent loop, same tools, same model — consumed as a JS API.

Why it matters: post-2026-06-15 the SDK and `-p` share the same Agent SDK credit bucket, so there's zero economic delta. This is a pure engineering-robustness play.

## Grounding

Not yet grounded — run `/soloflow:planner IDEA-014` to refine and ground. Sequencing: only pursue after the IDEA-013 vs IDEA-014 decision has been made (mutually exclusive for the Claude panel).

## Slices

### Migrate from claude -p subprocess to Claude Agent SDK as an embedded library
See `slices[0].description` in frontmatter. Concrete scope sketch:

- `ClaudeCodeManager` (`main/src/services/panels/claude/claudeCodeManager.ts`) stops being a process manager and becomes an SDK client.
- `AbstractCliManager`'s PTY scaffolding stays for the terminal panel but the Claude panel doesn't use it.
- `parseClaudeStreamEvent` and the streamParser pipeline (`main/src/services/streamParser/`) get replaced by SDK-emitted typed events. The discriminated-union pattern from the `typed-stream-event-schema` epic survives in spirit.
- MCP permission gate becomes an in-process callback; review queue plumbing simplifies materially (no `CYBOFLOW_ORCH_SOCKET` Unix-socket round-trip).
- `--resume <sessionId>` flow becomes SDK session-management calls.

### Engineering wins

- No `claude` install required on the user's machine.
- No PATH discovery (`claudeCodeManager.ts:187-200`).
- No `electron:rebuild` foot-gun from `node-pty` for the Claude panel (terminal panel still uses it).
- No `(child exited) AND (stdout EOF) AND parser queue drained` watchdog — completion is just `await`.
- No line-splitter / never-throws-JSON.parse layer between Claude and cyboflow.

### Trade-offs accepted

- SDK version is pinned in cyboflow's bundle (no "bring your own `claude`" affordance).
- CLI feature parity (new tools, slash commands) becomes cyboflow's responsibility to track on SDK release cadence.

## Open Questions

See `open_questions[]` in frontmatter.

## Assumptions

See `assumptions[]` in frontmatter.

## Sequencing

Mutually exclusive with IDEA-013 for the Claude panel. The prototype validates which path users care about (subscription billing vs. richer UI). IDEA-014 only makes sense if IDEA-013 is rejected on product grounds, OR as a parallel "premium tier" that pays the Agent SDK credit for the structured-UI experience.

## Refinement notes (added 2026-05-20)

The decomposer should treat the 9-step skeleton in `EPIC-claude-agent-sdk-migration.md` as the canonical starting point — it covers the Claude *panel* substrate replacement well (SDK install, ApprovalRouter, typed events retarget, claudeCodeManager rewrite, MCP bridge deletion, stream-json parser deletion, completion detection swap, test migration, integration verify).

Two scope additions discovered during manual smoke testing on 2026-05-20 that the panel-focused 9-step skeleton does NOT cover and MUST become explicit tasks under this epic:

**Addition 1 — Wire orchestrator-side SDK execution (workflow runs)**

The workflow-run path (`main/src/orchestrator/runLauncher.ts:102-195`) has a `runExecutor`-gated branch at lines 154-167 that would enqueue SDK execution onto a per-run `PQueue`. That branch is dormant today because `RunExecutor` and `RunQueueRegistry` are not constructed in `main/src/index.ts` bootstrap (`AppServices` wiring). Effect: starting a workflow run creates the worktree + writes per-run `.mcp.json`, emits a single synthetic `run_started` event (line 142-149, labeled "Wiring proof"), and returns — Claude is never invoked. Required:
- Construct `RunExecutor` and `RunQueueRegistry` in `main/src/index.ts` bootstrap and pass them to `RunLauncher`.
- `RunExecutor.execute(runId)` should invoke the SDK against the run's worktree, using the same `ApprovalRouter` / SDK options layer that the panel uses (single SDK substrate, two callers).
- Delete (or reframe) the synthetic `run_started` "wiring proof" event once real SDK stream events flow.
- The legacy MCP-bridge-write branch in `RunLauncher` (lines 125-134) is conditional on `!runExecutor` — it deletes itself when `RunExecutor` is wired. Confirm and remove cleanly.

**Addition 2 — Replace `"unknown"` stream-event tag with proper discriminator handling**

`frontend/src/services/cyboflowApi.ts:34` (the renderer's stream-event subscriber) logs every event whose `type` it doesn't recognize as `"unknown"`, and `RunView.tsx` then JSON.stringifies the payload — producing a raw-blob dump in the UI. Once real SDK-shaped events flow (post-Addition-1 + post-claudeCodeManager-rewrite), wire `cyboflowApi.ts` to recognize the SDK's typed `system | assistant | user | result | stream_event` discriminators (shared with `shared/types/claudeStream.ts`) and route them to the typed renderer paths. Remove the `"unknown"` catch-all (or keep it gated to truly novel future event types, but logged at warn-level, not info).

Both additions are downstream of the panel substrate work (steps 1-7 of the existing skeleton). Addition 1 must land before workflow runs are end-to-end testable. Addition 2 is cosmetic-but-load-bearing for the integration-verify success signal.
