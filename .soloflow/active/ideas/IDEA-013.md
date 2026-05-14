---
id: IDEA-013
type: FEATURE
status: draft
created: 2026-05-14T00:00:00Z
source: braindump
slices:
  - title: "Interactive-mode support to preserve subscription billing"
    description: "Pivot cyboflow's Claude integration off `claude -p --output-format stream-json` and onto interactive `claude` in a node-pty PTY, so users can run parallel agents against their existing Claude Pro/Max chat allowance instead of burning the separate Agent SDK credit bucket. Replace the MCP --permission-prompt-tool gate with PreToolUse hooks in per-worktree .claude/settings.json that post tool-use requests over CYBOFLOW_ORCH_SOCKET and block until the orchestrator answers. Replace the structured Claude panel UI with an xterm.js view. New heuristic completion-detection (PostToolUse + PTY quiescence). New resume model via the /resume slash command typed into the TUI."
    value_statement: "Preserves the 'run 8 parallel agents on your existing Claude subscription' value proposition that the post-2026-06-15 Agent SDK credit split otherwise breaks."
open_questions:
  - question: "Roll-our-own (interactive PTY + .claude/settings.json shell hook) vs adopt Shannon (github.com/dexhorthy/shannon, MIT) as the substrate? Shannon already drives interactive `claude` in tmux, tails the on-disk transcript, and emits `claude -p`-compatible stream-json — which would collapse most of this idea's accepted trade-offs (structured UI, typed events, deterministic completion all survive). Decision hinges on Shannon's bidirectional bridge maturity at planning time (currently 'Planned' not 'Implemented' as of 2026-05-13) and acceptability of new system deps (Bun, tmux)."
    candidates: []
  - question: "Do Claude Code PreToolUse hooks fire in interactive mode and can they return a synchronous {decision: deny|approve|ask} verdict that blocks the tool call? If they're silently -p-only or fire asynchronously, the roll-our-own branch collapses (Shannon branch may still survive — Shannon's spec uses an injected stdio MCP bridge rather than shell hooks for permission gating)."
    candidates: []
  - question: "Is the loss of the structured Claude panel UI (typed assistant messages, code-block rendering, tool-call expansion) acceptable to users, or is the structured view part of the perceived product value? Under the Shannon branch this loss is avoided entirely; under roll-our-own it remains a regression from the SDK substrate."
    candidates: []
  - question: "How is completion detected reliably from interactive output? Roll-our-own: PostToolUse hook + quiescence timer (heuristic). Shannon: transcript-tail to terminal `result` message (deterministic, mirrors today's `-p` gate)."
    candidates: []
assumptions:
  - "PreToolUse hooks in interactive `claude` can block synchronously on a Unix-socket round trip without timing out the parent process. (Roll-our-own branch only — Shannon uses stdio MCP bridge over its own Unix socket.)"
  - "xterm.js (already a dep for the terminal panel) can render the Claude TUI output cleanly inside the existing panel container. (Roll-our-own only — Shannon emits stream-json, so the existing structured Claude panel renders unchanged.)"
  - "The /resume slash command typed into the TUI is a reliable substitute for the current --resume <sessionId> CLI flag. (Roll-our-own only — Shannon resumes by session id with `query({ options: { resume } })`.)"
  - "Per-worktree .claude/settings.json is honored by `claude` when launched in that worktree as cwd. (Roll-our-own only — Shannon injects `--settings '{...}'` rather than relying on per-worktree files.)"
  - "If adopting Shannon: tmux and Bun (or a vendored Node port) on the user's machine are acceptable additions to cyboflow's system-dep footprint alongside the existing `claude` and `git` requirements."
research_recommendation: recommended
research_rationale: "Three concrete validation needs: (1) re-evaluate Shannon's bidirectional bridge implementation status at planning time — if implemented and stable, it is the more attractive substrate by a wide margin; (2) probe Claude Code PreToolUse hooks in interactive mode (still needed for the roll-our-own fallback); (3) review Claude Code docs for current interactive-mode permission/hook contract. A 10-line shell hook in .claude/settings.json logging to a file + a manual interactive Claude run is the cheapest probe for #2."
---

# Interactive-mode support to preserve subscription billing

## Context

On 2026-06-15 Anthropic moves `claude -p` and the Claude Agent SDK out of the regular Claude plan chat allowance into a separate monthly Agent SDK credit bucket (Pro: $20/mo, Max 5x: $100/mo). Interactive `claude` continues to ride the regular chat allowance. At cyboflow's 8x concurrent-runs design point, the Agent SDK credit pool evaporates fast — eroding the "run parallel agents on your existing Claude subscription" value proposition. Competitor harnesses that drive interactive `claude` ride the user's chat allowance instead.

See memory note `anthropic_sdk_billing_change_june_2026.md` for the full billing context.

## Raw Input

IDEA 1 — Interactive-mode support to preserve subscription billing.

Goal: pivot cyboflow's Claude integration off `claude -p --output-format stream-json` and onto interactive `claude` in a node-pty PTY, so users can run parallel agents against their existing Claude Pro/Max chat allowance instead of burning the separate Agent SDK credit bucket.

Why it matters: post-2026-06-15 the "run 8 parallel agents on your existing Claude subscription" value prop only holds if cyboflow drives interactive `claude`. The cross-workflow review queue (the actual differentiator) can survive on the interactive substrate via Claude Code's PreToolUse hooks instead of the --permission-prompt-tool MCP gate.

## Grounding

Not yet grounded — run `/soloflow:planner IDEA-013` to refine and ground. Sequencing: this is the **post-prototype** step. v1 prototype completes on the Claude Agent SDK (IDEA-014). IDEA-013 then lands to preserve subscription billing past the 2026-06-15 Agent-SDK-credit split, by pivoting the Claude panel from in-process SDK calls onto interactive `claude` in a node-pty PTY with a `PreToolUse` shell hook posting to the already-wired Unix socket. Pre-work probe (10-line shell hook in `.claude/settings.json` verifying sync-blocking hook semantics) can run in parallel with the SDK prototype sprint to de-risk the eventual pivot.

## Slices

### Interactive-mode support to preserve subscription billing
See `slices[0].description` in frontmatter. Concrete scope sketch:

- Drop `-p` and `--output-format stream-json` from `main/src/services/panels/claude/claudeCodeManager.ts:107`.
- Stop killing/respawning the PTY per turn in `claudeCodeManager.ts:613` (`continuePanel`); write prompts into PTY stdin instead.
- Replace the MCP `--permission-prompt-tool` gate with a `PreToolUse` hook in per-worktree `.claude/settings.json` that posts tool-use requests over `CYBOFLOW_ORCH_SOCKET` and blocks until the orchestrator answers.
- Replace the structured Claude panel UI with an xterm.js view (xterm.js is already a dep — used in the terminal panel).
- New completion-detection heuristic (`PostToolUse` hook + PTY-output quiescence timer) replacing the §5.1 `(child exited) AND (stdout EOF) AND parser queue drained` gate.
- New resume model: use the `/resume` slash command typed into the TUI; conversation state is owned by Claude, not cyboflow.

### Trade-offs accepted

The accepted trade-offs differ sharply between the two candidate substrates. Roll-our-own is the worst-case; Shannon (if its bidirectional bridge has shipped by planning time) eliminates most of them.

| Trade-off | Roll-our-own (node-pty + xterm.js + shell hooks) | Shannon (tmux + transcript tail + injected MCP bridge) |
|---|---|---|
| Lose structured Claude panel UI | yes — regression FROM the SDK substrate | **no** — Shannon emits `-p`-compatible stream-json |
| Lose typed event stream from SDK `query()` | yes | **no** — same stream-json shapes today's `-p` produces |
| Completion detection becomes heuristic | yes (PostToolUse + PTY quiescence) | **no** — terminal `result` message in transcript is deterministic |
| `typed-stream-event-schema` schemas unused for Claude panel | yes | **no** — schemas keep applying |
| Most orchestrator/tRPC stream-parsing deletes | yes | **no** — survives |
| New user system dep | none beyond `claude` (already required) | adds `tmux` + (Bun OR a vendored Node port) |

If the Shannon bidirectional-bridge work has not landed at planning time, the choice is between (a) waiting for it, (b) contributing the bridge upstream as part of cyboflow's IDEA-013 work, or (c) falling back to the roll-our-own row.

### What stays

- The cross-workflow review queue (the real differentiator), now powered by `PreToolUse` hooks instead of the MCP permission tool.
- Parallel workflow runs.
- Subscription billing (the original value prop).

## Open Questions

See `open_questions[]` in frontmatter.

## Assumptions

See `assumptions[]` in frontmatter.

## Prior art — Shannon

`github.com/dexhorthy/shannon` (MIT, 182★ as of 2026-05-13, recent activity) is the prior art most directly applicable to this idea. Shannon launches interactive `claude` inside a tmux session, sends prompts, tails the on-disk transcript at `~/.claude/projects/<cwd-key>/<session>.jsonl`, and emits `claude -p`-compatible stream-json. By design it rides the user's subscription chat allowance rather than the post-2026-06-15 Agent SDK credit bucket. Shannon also ships an `@dexh/shannon-agent-sdk` facade that mirrors the Claude Agent SDK surface — meaning if cyboflow consumes SDK-shaped types under IDEA-014 (which we're queuing now), a future swap to `shannon-agent-sdk` could be close to a substrate-swap-by-import.

What Shannon already implements (per its `GOAL_PROGRESS.md` 2026-05-13):
- Interactive `claude` in tmux ✅
- Transcript-id discovery + JSONL stream ✅
- `system/init`, `assistant`, `result` events in stream-json ✅ (some "Partial parity" rows for exact field-by-field match)
- `SDK query()` async-iterable ✅ (partial parity vs Agent SDK)
- SIGINT/SIGTERM cleanup ✅
- Resume by session id ✅ (live-tested, partial)

What Shannon has spec'd but **not implemented** yet (the load-bearing piece for cyboflow's review queue):
- Bidirectional permission-gating bridge: *"Shannon injects generated `--settings '{...json...}'` into interactive Claude to hard-code bridge MCP servers/hooks while preserving normal Claude settings source merging; the injected stdio MCP bridge communicates back to the Shannon host over a Unix socket using oRPC."* — status: **Planned**, not implemented.

Implications for IDEA-013:
- **If the bridge ships before IDEA-013 planning**, adopting Shannon is the more attractive substrate by a wide margin — it eliminates the structured-UI regression, keeps the typed schemas in play, and preserves deterministic completion detection.
- **If the bridge has not shipped**, options are (a) wait, (b) contribute the bridge upstream as part of IDEA-013 (cleanest open-source play), or (c) implement IDEA-013 via the roll-our-own design and revisit Shannon in a later epic.
- **Runtime concern**: Shannon is Bun-native. Practical embedding paths for an Electron/Node host are (a) spawn Shannon as a subprocess via `npx @dexh/shannon` (cleanest, adds Bun + tmux as user system deps), (b) port the tmux-driver logic to Node (largest effort, severs upstream), (c) wait for a published Node build of `@dexh/shannon-agent-sdk`.

## Pre-work / Risk

Two cheap probes before committing — one per candidate substrate:

**Probe A (roll-our-own)**: write a 10-line shell hook in `.claude/settings.json` that logs received PreToolUse JSON to a file, run interactive `claude` against a worktree, attempt a tool call, confirm the hook fires AND that returning `{"decision": "deny"}` actually blocks the call. If hooks are silently `-p`-only or fire async, the roll-our-own branch collapses.

**Probe B (Shannon)**: at IDEA-013 planning time, re-read Shannon's `GOAL_PROGRESS.md` and check whether the "Bidirectional SDK bridge" row has moved from **Planned** to **Implemented**. If it has, run `npx @dexh/shannon -p "..." --output-format=stream-json --verbose` against a cyboflow worktree and confirm the emitted stream is shape-compatible with what cyboflow's `MessageProjection` / `EventRouter` already consume. If it hasn't, evaluate the cost of contributing the bridge upstream vs. falling back to Probe A's path.

## Sequencing

Sequenced AFTER IDEA-014 (SDK migration completes the prototype substrate). NOT mutually exclusive with IDEA-014 — the SDK sprint preserves the IPC server (`cyboflowPermissionIpcServer.ts`) and its `start()` call site specifically so this idea lands as a transport swap (shell hook → existing socket → `ApprovalRouter`), not as an un-deletion of removed code. The shared `ApprovalRouter` interface in `shared/types/approval.ts` (created by TASK-588) means review-queue UI and downstream subscribers don't churn across the SDK→interactive transition. `-p` is not on the path — the SDK sprint deletes the `-p` substrate entirely; IDEA-013 layers interactive-mode support on top of the survived scaffolding.
