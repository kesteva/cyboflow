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
