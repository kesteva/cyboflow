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
  - question: "Do Claude Code PreToolUse hooks fire in interactive mode and can they return a synchronous {decision: deny|approve|ask} verdict that blocks the tool call? If they're silently -p-only or fire asynchronously, this whole pivot collapses."
    candidates: []
  - question: "Is the loss of the structured Claude panel UI (typed assistant messages, code-block rendering, tool-call expansion) acceptable to users, or is the structured view part of the perceived product value? If structured view is non-negotiable, this becomes a 'premium tier' rather than the default."
    candidates: []
  - question: "How is completion detected reliably from interactive output? PostToolUse hook + quiescence timer is heuristic — what false-positive / false-negative rate is acceptable, and how does the watchdog interact with long-running tool calls (Bash, fetches)?"
    candidates: []
assumptions:
  - "PreToolUse hooks in interactive `claude` can block synchronously on a Unix-socket round trip without timing out the parent process."
  - "xterm.js (already a dep for the terminal panel) can render the Claude TUI output cleanly inside the existing panel container."
  - "The /resume slash command typed into the TUI is a reliable substitute for the current --resume <sessionId> CLI flag."
  - "Per-worktree .claude/settings.json is honored by `claude` when launched in that worktree as cwd."
research_recommendation: recommended
research_rationale: "Two concrete validation needs: (1) probe Claude Code PreToolUse hooks in interactive mode to confirm sync-blocking behavior; (2) review Claude Code docs for current interactive-mode permission/hook contract. A 10-line shell hook in .claude/settings.json logging to a file + a manual interactive Claude run is the cheapest probe."
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

- Lose the structured Claude panel UI (typed assistant messages, code-block rendering, tool-call expansion). Note: under the now-decided sequencing, this is a regression FROM the SDK substrate, not from `-p` — the SDK prototype delivers structured UI; IDEA-013 trades it for subscription billing.
- Lose the typed-event stream from `@anthropic-ai/claude-agent-sdk` query() (interactive TUI emits terminal bytes, not typed events).
- Completion detection becomes heuristic (PostToolUse hook + PTY quiescence) rather than promise-resolution-deterministic.
- The retargeted `typed-stream-event-schema` schemas become unused for the Claude panel (still in tree for IDEA-015 multi-provider reuse).

### What stays

- The cross-workflow review queue (the real differentiator), now powered by `PreToolUse` hooks instead of the MCP permission tool.
- Parallel workflow runs.
- Subscription billing (the original value prop).

## Open Questions

See `open_questions[]` in frontmatter.

## Assumptions

See `assumptions[]` in frontmatter.

## Pre-work / Risk

Cheap probe before committing: write a 10-line shell hook in `.claude/settings.json` that logs received PreToolUse JSON to a file, run interactive `claude` against a worktree, attempt a tool call, confirm the hook fires AND that returning `{"decision": "deny"}` actually blocks the call. If hooks are silently `-p`-only or fire async, this whole pivot collapses and the answer shifts to IDEA-014 (SDK migration) instead.

## Sequencing

Sequenced AFTER IDEA-014 (SDK migration completes the prototype substrate). NOT mutually exclusive with IDEA-014 — the SDK sprint preserves the IPC server (`cyboflowPermissionIpcServer.ts`) and its `start()` call site specifically so this idea lands as a transport swap (shell hook → existing socket → `ApprovalRouter`), not as an un-deletion of removed code. The shared `ApprovalRouter` interface in `shared/types/approval.ts` (created by TASK-588) means review-queue UI and downstream subscribers don't churn across the SDK→interactive transition. `-p` is not on the path — the SDK sprint deletes the `-p` substrate entirely; IDEA-013 layers interactive-mode support on top of the survived scaffolding.
