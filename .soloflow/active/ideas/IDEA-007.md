---
id: IDEA-007
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 1 — Orchestrator Foundation"
roadmap_epic: "approval-router-and-permission-fix"
slices:
  - title: "Rename mcpPermissionBridge → cyboflowPermissionBridge"
    description: "Rename file, class, socket path to ~/.cyboflow/sockets/, MCP server name to mcp__cyboflow-permissions__approve_permission. Update --permission-prompt-tool flag in claudeCodeManager. Architecture research clarified the socket path is passed via argv[3], NOT MCP_PERMISSION_SOCKET env var."
    value_statement: "Adopts the working Crystal pattern with Cyboflow identity; corrects the design doc's MCP_PERMISSION_SOCKET claim"
  - title: "Implement ApprovalRouter replacing PermissionManager"
    description: "main/src/orchestrator/approvalRouter.ts. Parses workflow policy from frontmatter (permission_mode). Under per-run p-queue: writes approvals row + transitions workflow_runs to awaiting_review atomically via the transaction helper."
    value_statement: "Single load-bearing primitive for the review queue; replaces Crystal's no-timeout broken implementation"
  - title: "60-minute setTimeout per pending approval that replies deny on socket"
    description: "Per-approval setTimeout fires deny on the Unix socket and updates the row to status=expired. This is the #1 non-negotiable failure-mode mitigation from §5.7."
    value_statement: "Prevents Claude PTY from hanging indefinitely after user walks away"
  - title: "clearPendingForRun(runId) on cancel/fail/app-close"
    description: "Each pending approval for the affected run gets a deny socket reply before the PTY is killed. Otherwise the PTY blocks forever awaiting a reply that never comes."
    value_statement: "Clean shutdown semantics; no orphaned PTYs on app quit"
  - title: "Boot-time recovery pass for stale awaiting_review rows"
    description: "On app boot, any workflow_runs with status=awaiting_review transitions to status=failed with reason='app_restart'. The Unix socket is ephemeral; stale rows cannot be resumed."
    value_statement: "Predictable behavior across app restarts; no zombie awaiting_review state"
  - title: "Race protection: status guard on awaiting_review→running UPDATE"
    description: "UPDATE workflow_runs SET status='running' WHERE id=? AND status='awaiting_review'. Check changes >0 before sending allow on socket. Prevents revival of canceled runs by late approvals."
    value_statement: "Eliminates approval/cancel race conditions under the per-run mutex"
open_questions: []
assumptions:
  - "60-minute timeout is the right default. User-needs research §6 noted 25-30min may be better for Pomodoro-style work but 60min is the design doc default and adjustable post-MVP."
research_recommendation: not_needed
research_rationale: "Risks research §4 documented the no-timeout bug at the exact line. Architecture research §2 documented the argv-vs-env-var discrepancy. All implementation details are concrete."
---

# Approval Router and Permission Fix

## Raw Input

Generated from ROADMAP-001, Phase "Phase 1 — Orchestrator Foundation", Epic "approval-router-and-permission-fix".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

Risks research §4 found `permissionManager.ts:73` is a bare Promise with no timeout/reject path. Design doc §5.7 makes 60-minute deny-on-socket non-negotiable. Architecture research §2 grounded the argv-based socket-path-passing convention.

## Slices

See frontmatter `slices` field. Six slices: rename, ApprovalRouter, timeout, clear-pending, boot recovery, race protection.

## Open Questions

None.

## Assumptions

- 60-minute timeout is the right default for v1. Adjustable in config later.
