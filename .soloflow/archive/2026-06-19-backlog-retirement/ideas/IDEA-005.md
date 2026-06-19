---
id: IDEA-005
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 1 — Orchestrator Foundation"
roadmap_epic: "stream-parser-to-main"
slices:
  - title: "Create main/src/services/streamParser/ with parsing pipeline"
    description: "LineBufferer (carries partial lines across chunks), JSONParser (per-line, drops parse errors with WARN — never throws into event loop), TypedEventNarrowing (Zod schema with .passthrough() + unknown default), EventRouter (per-runId fanout via EventEmitter)."
    value_statement: "Main-process parser unblocks orchestrator-side event consumption; renderer becomes a downstream consumer"
  - title: "Replace renderer ClaudeMessageTransformer consumption with tRPC subscription"
    description: "Renderer subscribes to main-process EventEmitter via tRPC observable. Existing renderer-side parser is deleted; renderer never sees raw JSONL."
    value_statement: "Single source of truth for parsed events; eliminates renderer-vs-orchestrator drift"
  - title: "Triple-gate completion detector"
    description: "(child exited) AND (stdout EOF) AND (parser queue drained), with 30s watchdog grace before forcing failed. Never trust `result` event alone — issue #1920 is closed-not-planned per ecosystem and risks research."
    value_statement: "Mandatory mitigation for the permanent Claude Code regression; prevents hung runs"
  - title: "Append every parsed event to raw_events table"
    description: "EventRouter dispatches to raw_events insert (audit log source of truth). Other consumers (messages projection, approvals routing, usage accumulator) read from the typed event stream."
    value_statement: "Append-only event sourcing; projections can be replayed if reducer logic changes"
  - title: "Force approve permission mode (no --dangerously-skip-permissions default for Cyboflow runs)"
    description: "Override Crystal's ClaudeCodeManager default that uses --dangerously-skip-permissions unless effectiveMode === 'approve'. For Cyboflow runs, approve is mandatory."
    value_statement: "Every Cyboflow run flows through the permission socket; queue can't be bypassed"
open_questions: []
assumptions:
  - "EventEmitter-based fanout is sufficient for 8 concurrent runs with throttled (60Hz) downstream consumers."
research_recommendation: not_needed
research_rationale: "Architecture and risks research jointly specified the completion-gate pattern and the parser pipeline shape. The permission-mode default flip was identified in architecture research §7."
---

# Stream Parser to Main

## Raw Input

Generated from ROADMAP-001, Phase "Phase 1 — Orchestrator Foundation", Epic "stream-parser-to-main".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

Design doc §6.2 names "move Crystal's transformer renderer→main on day 1" as one of three day-1 disciplines. Architecture research §1 and §7 confirmed Crystal's current parser is renderer-side over raw JSONL. The completion-gate pattern is grounded in issues #1920 (missing result) and #25629 (hang after result).

## Slices

See frontmatter `slices` field. Five slices covering parser pipeline, renderer migration, completion gate, raw_events sink, and approve-mode default flip.

## Open Questions

None.

## Assumptions

- EventEmitter performance under 8 concurrent runs with throttled consumers is acceptable. Verified empirically during the day-3 gate test.
