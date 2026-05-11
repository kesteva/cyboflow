---
epic: workflow-runs-and-day3-gate
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-008]
---

# Epic: Workflow Runs and Day-3 Gate

## Objective

Wire workflow selection → deterministic worktree creation → Claude Code spawn with per-run MCP config → typed events flowing through the orchestrator end-to-end. Prove the day-3 gate: two workflow runs in different SoloFlow workflows can both pause on tool-use approvals and be approved in any order via direct tRPC mutation. This epic validates the fork-path bet — if the gate fails, the greenfield-reset option triggers per the brief's risk tolerance.

## Scope

- In scope:
  - Workflow registry seeded with the 5 SoloFlow workflows (`soloflow`, `planner`, `sprint`, `compound`, `prune`)
  - Frontmatter-parsed `permission_mode` per workflow with default fallback
  - Deterministic worktree naming `cyboflow/<workflow-name>/<runId8>` under `<repo>/.cyboflow/worktrees/`
  - Auto-write `.cyboflow/worktrees/` to `.gitignore` on project add (and on first run for existing projects)
  - Per-run `.mcp.json` containing `cyboflow-permissions` bridge with `CYBOFLOW_RUN_ID` + `CYBOFLOW_ORCH_SOCKET` env vars
  - `--strict-mcp-config` flag passed when spawning Claude
  - Minimal frontend: workflow picker dropdown, run start button, single run view subscribed to tRPC event stream
  - Two-run day-3 gate integration test (sprint run + prune run, approve out of order)
- Out of scope:
  - Full `<ReviewQueueView />` (epic `review-queue-ui`, Phase 2)
  - Outbound `CyboflowMcpServer` for queue introspection (epic `cyboflow-mcp-server`, Phase 2)
  - Stuck-state detection / cross-run deadlock surfacing (epic `stuck-detection-and-observability`, Phase 2)
  - Auto-cleanup of worktrees on completion (kept until user manually removes)
  - Custom workflow authoring or agent customization

## Success Signal

Two runs in different SoloFlow workflows (sprint + prune) each pause on the `cyboflow-permissions` socket bridge when Claude requests tool use, can be approved in any order via direct tRPC mutation, and each resumes Claude independently. The integration test passes deterministically. The 5 workflows appear in the picker; selecting one and clicking "Start" creates a deterministically-named worktree, writes a per-run `.mcp.json`, spawns Claude with `--strict-mcp-config`, and the run view shows typed stream events flowing.
