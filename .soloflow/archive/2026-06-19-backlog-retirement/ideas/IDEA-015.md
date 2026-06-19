---
id: IDEA-015
type: FEATURE
status: draft
created: 2026-05-14T00:00:00Z
source: braindump
slices:
  - title: "Multi-provider support, starting with OpenAI Codex"
    description: "Add a second agent provider beyond Anthropic Claude, beginning with OpenAI Codex, so users on other AI subscriptions can drive parallel runs with cyboflow's review queue. OpenAI's subscription model for Codex / agentic usage is less restrictive than Anthropic's post-2026-06-15 Agent SDK credit split, which restores the 'use your existing AI subscription for parallel agent runs' product story for OpenAI subscribers. Leverages the existing `AbstractCliManager` extension surface (preserved per docs/cyboflow_system_design.md:64) and the typed-stream-event-schema discriminated-union pattern, which generalizes to per-provider variants. Also reduces single-vendor risk."
    value_statement: "Restores 'use your existing AI subscription for parallel agent runs' as a viable product story for OpenAI subscribers, where Anthropic's billing change broke it for Claude users."
open_questions:
  - question: "Does OpenAI Codex / Responses API have a subscription tier that genuinely permits parallel agentic usage without metering, or are heavy parallel runs still rate-limited or token-metered in practice?"
    candidates: []
  - question: "What's the streaming event format and tool-use protocol for OpenAI's agentic API? Does the typed-stream-event-schema discriminated-union pattern generalize cleanly, or does OpenAI's surface need a different abstraction?"
    candidates: []
  - question: "Does OpenAI's agentic surface support MCP for tool-use permission gating, or does it need an alternative tool-use intercept (e.g. function-call interception layer in cyboflow)?"
    candidates: []
  - question: "Auth model — does OpenAI Codex authenticate via OAuth (like `claude` login does) or require an explicit API key in cyboflow's settings? This affects onboarding UX significantly."
    candidates: []
  - question: "Does the model-selection UX gain a provider axis (single 'model' dropdown with prefixed entries) or a separate provider picker + per-provider model picker? Affects settings schema and per-session model storage."
    candidates: []
assumptions:
  - "`AbstractCliManager` (`main/src/services/panels/cli/AbstractCliManager.ts`) is the right extension surface — confirmed by `docs/cyboflow_system_design.md:64` and the @cyboflow-hidden / preservation conventions in CLAUDE.md."
  - "The cross-workflow review queue can be fed from multiple provider-specific permission-intercept paths without per-provider review UI."
  - "OpenAI ships an SDK or stable streaming HTTP surface comparable to the @anthropic-ai/claude-agent-sdk."
  - "Per-provider event schemas can be expressed as separate discriminated-union branches without churning the existing Anthropic typed-stream-event-schema."
research_recommendation: recommended
research_rationale: "Substantial unknowns about OpenAI's agentic API surface: subscription billing rules for parallel use, tool-use streaming protocol, MCP-equivalent permission gating, auth model. A shadow-researcher pass before any planning is high-value."
---

# Multi-provider support, starting with OpenAI Codex

## Context

Anthropic's 2026-06-15 Agent SDK billing change splits agent usage from the Claude plan chat allowance. OpenAI's subscription model for agentic usage is reportedly less restrictive — if that bears out under cyboflow's parallel-runs design point, OpenAI users get the "use your existing AI subscription for parallel agent runs" story that Claude users lose post-2026-06-15. Multi-provider also reduces single-vendor risk for cyboflow.

See memory note `anthropic_sdk_billing_change_june_2026.md` for the full billing context.

## Raw Input

IDEA 3 — Multi-provider support, starting with OpenAI Codex.

Goal: add a second agent provider beyond Anthropic Claude, beginning with OpenAI Codex, so users on other AI subscriptions can drive parallel runs with cyboflow's review queue.

Why it matters: OpenAI's subscription model for Codex / agentic usage is less restrictive than Anthropic's post-2026-06-15 Agent SDK credit split, which restores the "use your existing AI subscription for parallel agent runs" product story for OpenAI subscribers. Multi-provider also reduces single-vendor risk.

## Grounding

Not yet grounded — run `/soloflow:planner IDEA-015` to refine and ground. Sequencing: this is no longer blocked on an IDEA-013-vs-IDEA-014 architecture decision (that's been made — SDK first to complete the prototype, IDEA-013 second to preserve subscription billing). IDEA-015 sequences AFTER IDEA-013 lands, so the Codex integration mirrors the same dual-substrate shape (SDK-style for the structured-UI tier, interactive-TUI-style for the subscription-billing tier) the Claude panel will already have. The `ApprovalRouter` interface from IDEA-014 (TASK-588) is the foundation per-provider permission gates plug into.

## Slices

### Multi-provider support, starting with OpenAI Codex
See `slices[0].description` in frontmatter. Concrete scope sketch:

- Leverage the existing `AbstractCliManager` extension surface (`main/src/services/panels/cli/AbstractCliManager.ts`), preserved per `docs/cyboflow_system_design.md:64` as the explicit extension point.
- New `CodexManager` subclass (or equivalent) — note that `AbstractAIPanelManager` / `BaseAIPanelHandler` are collapse candidates per CLAUDE.md, so design the new provider on `AbstractCliManager` directly.
- Per-provider event schemas in the parser (the `typed-stream-event-schema` epic's discriminated-union pattern generalizes — add a `provider` discriminator).
- Per-provider permission/approval surfaces routed into the same cross-workflow review queue.
- Model selection UX gains a provider axis.
- New `.mcp.json` (or equivalent) wiring if the provider supports MCP; otherwise design an alternative tool-use intercept (likely a function-call interception layer).

### Strategic rationale

- Reduces single-vendor risk: not all of cyboflow's value rests on one provider's billing decisions.
- Opens the door to additional providers (Gemini, local LLMs via Ollama, etc.) once the multi-provider abstraction is in place.
- Validates the `AbstractCliManager` extension-surface bet — it's been preserved through the Crystal cuts on the assumption that v2 would add CLI tool integrations; this is that v2 work.

## Open Questions

See `open_questions[]` in frontmatter.

## Assumptions

See `assumptions[]` in frontmatter.

## Pre-work / Research needed

- OpenAI Codex / Responses API subscription billing rules (what tiers exist, how parallel runs are metered).
- Tool-use event format and streaming protocol for OpenAI's agentic API.
- MCP-equivalent permission gating, or alternative tool-use intercept.
- Auth model (OAuth like `claude` or API key required).

## Sequencing

Sequences AFTER IDEA-013. The Claude panel will have both substrates (SDK from IDEA-014, interactive TUI from IDEA-013) — the Codex integration mirrors both, exposing the same provider-tier choice (SDK-style for richer UI, interactive-TUI-style for permissive subscription billing where the provider supports it). Don't start until IDEA-013 is integrated so the dual-substrate pattern is established and the abstraction can generalize cleanly.
