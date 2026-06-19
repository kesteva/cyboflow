---
id: IDEA-010
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 2 — Review Queue and Self-Host"
roadmap_epic: "cyboflow-mcp-server"
slices:
  - title: "main/src/orchestrator/mcpServer/cyboflowMcpServer.ts as stdio MCP subprocess"
    description: "Spawned per Claude session via the per-run .mcp.json. Connects to orchestrator over Unix socket using CYBOFLOW_RUN_ID and CYBOFLOW_ORCH_SOCKET env vars. Template from existing cyboflowPermissionBridge pattern."
    value_statement: "Inbound and outbound MCP architecture unified — both stdio subprocesses, both Unix-socket-bridged to orchestrator"
  - title: "Tool: cyboflow_list_pending_approvals (read)"
    description: "Returns the current queue state including approvals from OTHER parallel runs. Lets Claude sessions reason about cross-run state."
    value_statement: "Enables future agent patterns that need queue awareness; minimal read-only surface"
  - title: "Tool: cyboflow_get_run (read)"
    description: "Fetches a workflow run's state by ID. Read-only."
    value_statement: "Useful for diagnostic prompts during a run"
  - title: "Tool: cyboflow_submit_checkpoint (limited write)"
    description: "Writes a checkpoint marker — the ONLY write surface. NO 'approve from inside Claude' tool in v1 — the human-in-the-loop is the product. Resist scope creep here."
    value_statement: "Preserves the product thesis; checkpoint markers enable compound learning patterns"
  - title: "asarUnpack pattern for packaged DMG"
    description: "MCP server script must be reachable from a packaged Electron app via asar.unpacked. Extract to ~/.cyboflow/ at first run if needed."
    value_statement: "Works in production DMG, not just dev mode"
  - title: "Crash isolation: subprocess errors to dedicated channel"
    description: "MCP server stderr does NOT leak to Claude's stdout. Logged separately. Issue #216 from Crystal showed this pattern of MCP error noise is real."
    value_statement: "Clean Claude session output; debuggable MCP failures"
  - title: "App-boot health check for MCP server startup"
    description: "If the MCP server fails to start, surface a clear error in the app (e.g., red dot in status bar). Do NOT silently disable outbound tools."
    value_statement: "First-run diagnostic visibility; user sees what's broken instead of mysterious tool-call failures"
open_questions:
  - "Restart policy if MCP subprocess crashes mid-run? Auto-restart with backoff, or fail the run? Risks research flagged this as undecided."
assumptions:
  - "The MCP SDK's StdioServerTransport handles per-session env injection cleanly via the .mcp.json mechanism."
research_recommendation: not_needed
research_rationale: "Architecture research §6 detailed the subprocess architecture and asarUnpack risk. Risks research §7 detailed crash semantics and recovery decisions still open."
---

# Cyboflow MCP Server

## Raw Input

Generated from ROADMAP-001, Phase "Phase 2 — Review Queue and Self-Host", Epic "cyboflow-mcp-server".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

Design doc §5.6 defines the outbound MCP server. Ecosystem research corrected the doc's claim that Crystal has no outbound MCP today — it does (mcpPermissionBridge), so this epic templates from working code.

## Slices

See frontmatter `slices` field. Seven slices: subprocess shell, 3 tool surfaces (one write only), asarUnpack, crash isolation, health check.

## Open Questions

- Restart policy on MCP subprocess crash — auto-restart with backoff vs fail-the-run is undecided.

## Assumptions

- MCP SDK's StdioServerTransport correctly applies .mcp.json env injection.
