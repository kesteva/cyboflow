---
id: IDEA-003
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 1 — Orchestrator Foundation"
roadmap_epic: "typed-stream-event-schema"
slices:
  - title: "Write shared/types/claudeStream.ts with corrected discriminated union"
    description: "Define ClaudeStreamEvent with variants: system/init, system/api_retry, system/compact, assistant, user, result (4 subtypes: success | error_max_turns | error_max_budget_usd | error_during_execution), stream_event (NOT StreamDeltaEvent), plus unknown catch-all. All fields snake_case (matches actual JSON), not camelCase as in the design doc."
    value_statement: "Locks the parser-boundary contract before any parser code is written; downstream code is then mechanical"
  - title: "Zod schemas in main/src/services/streamParser/schemas.ts"
    description: "Zod discriminated union with .passthrough() (never crash on unknown fields), snake_case keys, default unknown variant. Use z.union for tool_result.content (string | array[{type, text}])."
    value_statement: "Runtime validation at the parser boundary; trusted types inside the application"
  - title: "Fixture-driven unit tests against real stream-json output"
    description: "Capture real Claude Code session output for each variant. Tests assert each fixture parses cleanly and TypeScript exhaustive-checks pass on the union."
    value_statement: "Catches schema drift early; gives a regression target when Anthropic changes the format"
open_questions: []
assumptions:
  - "Captured fixtures from running `claude -p --output-format stream-json --verbose --include-partial-messages` against simple prompts are sufficient for variant coverage in v1."
research_recommendation: not_needed
research_rationale: "Architecture research (§1) inspected the actual stream-json schema in detail, including subtype enumeration, casing, and the system/compact variant. Recommendations are fully specified."
---

# Typed Stream Event Schema

## Raw Input

Generated from ROADMAP-001, Phase "Phase 1 — Orchestrator Foundation", Epic "typed-stream-event-schema".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

System design §5.2 names the ClaudeStreamEvent 7-variant union but contains 7 documented errors (architecture research §1): camelCase vs snake_case field names; `result` event has 4 subtypes not 1; `system/compact` variant exists but is missing; `StreamDeltaEvent` should be `stream_event`; `ErrorEvent` is fictional (errors come via api_retry, result.error_during_execution, or stderr).

## Slices

See frontmatter `slices` field. Three slices: (1) corrected discriminated union in shared/, (2) Zod schemas with passthrough + unknown variant, (3) fixture tests.

## Open Questions

None — architecture research surfaced and corrected the schema gaps.

## Assumptions

- A small set of captured stream-json fixtures (from running Claude on hello-world prompts) gives sufficient coverage. Edge variants (system/compact specifically) may need synthetic fixtures since they only fire on long sessions.
