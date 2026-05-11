---
id: IDEA-008
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 1 — Orchestrator Foundation"
roadmap_epic: "workflow-runs-and-day3-gate"
slices:
  - title: "Workflow registry seeded with the 5 SoloFlow workflows"
    description: "Workflows table seeded with soloflow, planner, sprint, compound, prune. Parse each workflow's frontmatter at registration time for permission_mode. Store the parsed policy on the workflow_runs row at run start."
    value_statement: "Per-workflow policy is a first-class concept; queue routing logic can consult it"
  - title: "Deterministic worktree naming and location"
    description: "cyboflow/<workflow-name>/<runId8> branch + .cyboflow/worktrees/ parent dir. Replaces inherited AI-naming with the sortable greppable scheme. Auto-write .cyboflow/worktrees/ to .gitignore at project add."
    value_statement: "Sortable, greppable, namespace-scrubbable; no API hop at session start"
  - title: "Per-run .mcp.json with cyboflow-permissions bridge config"
    description: "Write per-run .mcp.json (or temp path) with the cyboflowPermissionBridge subprocess command + CYBOFLOW_RUN_ID + CYBOFLOW_ORCH_SOCKET env vars. Pass --strict-mcp-config to Claude to prevent user-global MCP servers from interfering."
    value_statement: "Per-session MCP scoping; isolation from user's other MCP servers"
  - title: "Minimal frontend: workflow picker + run start + single run view"
    description: "Workflow picker dropdown (5 options). Run start button. Single run view shows parsed event stream from tRPC subscription. Bare minimum to validate the orchestrator end-to-end."
    value_statement: "Visible end-to-end pipeline; UI can drive a real session before the queue UI exists"
  - title: "Day-3 gate test: two parallel runs, approve out of order"
    description: "Start a sprint run and a prune run; both hit tool-use approvals; user approves the prune one FIRST via direct tRPC mutation (queue UI not yet built — use a debug command); sprint resumes independently when its approval is decided afterward. THE EXPLICIT MILESTONE TEST."
    value_statement: "Validates the fork-path bet. If this test fails, greenfield reset is on the table per the brief's risk tolerance."
open_questions: []
assumptions:
  - "The 5 SoloFlow workflow .md files exist in the user's setup (the user is the author; this is true for the v1 user)."
  - "Frontmatter parsing is straightforward YAML; doesn't need a fancy parser."
research_recommendation: not_needed
research_rationale: "Architecture research §6 detailed the .mcp.json pattern. Ecosystem research recommended --strict-mcp-config. The day-3 gate procedure is explicitly defined in the brief."
---

# Workflow Runs and Day-3 Gate

## Raw Input

Generated from ROADMAP-001, Phase "Phase 1 — Orchestrator Foundation", Epic "workflow-runs-and-day3-gate".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

Design doc §7 mitigation gate: "by end of day 3, two runs in different workflows must each be able to be paused on the queue, and the user must be able to approve them in any order." This epic is the day-3 gate.

## Slices

See frontmatter `slices` field. Five slices: workflow registry, deterministic naming, per-run MCP config, minimal frontend, day-3 gate test.

## Open Questions

None.

## Assumptions

- SoloFlow workflow .md files exist (true for the v1 author-user).
- YAML frontmatter parsing doesn't need special tooling.
