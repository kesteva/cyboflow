---
epic: approval-router-and-permission-fix
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-007]
---

# Approval Router and Permission Fix

## Objective

Replace Crystal's no-timeout `PermissionManager` with `ApprovalRouter`, the load-bearing primitive of the Cyboflow cross-workflow review queue. The router holds the Unix-socket reply to Claude's `--permission-prompt-tool` under the per-run p-queue, enforces a 60-minute timeout that replies `deny` on the socket (never silent expiration), denies all pending approvals when a run is canceled or the app closes, and recovers from stale `awaiting_review` rows on boot. Identity is rebranded from Crystal to Cyboflow throughout (file names, socket paths, MCP tool name).

## Scope

- In scope:
  - Rename `mcpPermissionBridge` → `cyboflowPermissionBridge`, socket path to `~/.cyboflow/sockets/cyboflow-permissions-<pid>.sock`, MCP server name `cyboflow-permissions`, MCP tool ID `mcp__cyboflow-permissions__approve_permission`
  - New `main/src/orchestrator/approvalRouter.ts` replacing `PermissionManager` as the singleton consumed by `PermissionIpcServer` (renamed `cyboflowPermissionIpcServer`)
  - Per-approval 60-minute `setTimeout` that fires `deny` on the socket and updates the `approvals` row to `status='expired'`
  - `clearPendingForRun(runId)` called on cancel / fail / app-close, sending `deny` on the socket for each pending approval before the PTY is killed
  - Boot-time recovery: any `workflow_runs` row in `awaiting_review` transitions to `failed` with `reason='app_restart'`
  - Race protection: status guard on the `awaiting_review → running` UPDATE (`WHERE id=? AND status='awaiting_review'`), check `changes > 0` before sending `allow`
- Out of scope:
  - Renderer UI for the review queue (handled in `review-queue-ui` epic)
  - Stuck-state detection / observability (handled in `stuck-detection-and-observability` epic)
  - The outbound `CyboflowMcpServer` (queue-read MCP server — handled in `cyboflow-mcp-server` epic)

## Success Signal

A run awaiting review for >60 minutes auto-denies on the socket and the PTY exits cleanly; closing the app while an approval is pending sends `deny` on the socket within 1s before the PTY is killed; rebooting the app with a stale `awaiting_review` row transitions it to `failed` with `reason='app_restart'` at boot; `grep -rn "crystal-permissions"` and `grep -rn "mcpPermissionBridge"` return no matches outside docs/research.
