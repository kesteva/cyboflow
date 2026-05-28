---
epic: cyboflow-mcp-server
created: 2026-05-11T00:00:00Z
status: complete
originating_ideas: [IDEA-010]
---

# Cyboflow MCP Server

## Objective

Ship the outbound `CyboflowMcpServer` as a stdio MCP subprocess that gives Claude sessions running inside Cyboflow workflows a minimal, read-mostly view of cross-run queue state. Templated from the existing `mcpPermissionBridge` pattern, the server connects to the orchestrator over a private Unix socket using `CYBOFLOW_RUN_ID` and `CYBOFLOW_ORCH_SOCKET` env vars injected via the per-run `.mcp.json`. The epic preserves the product thesis (human-in-the-loop) by exposing two read tools and one limited write tool (checkpoint marker only) — no "approve from inside Claude" surface in v1.

## Scope

- In scope:
  - `main/src/orchestrator/mcpServer/cyboflowMcpServer.ts` stdio subprocess scaffold (connects to orchestrator over Unix socket on bootstrap)
  - Three tool surfaces: `cyboflow_list_pending_approvals` (read), `cyboflow_get_run` (read), `cyboflow_submit_checkpoint` (limited write — marker only)
  - Orchestrator-side socket protocol extension for MCP queries (separate from permission protocol)
  - Spawn lifecycle with `asarUnpack` extraction pattern for packaged DMG
  - Crash isolation: subprocess stderr captured by dedicated logger channel, never leaks to Claude stdout
  - Single-attempt auto-restart-with-backoff policy (decided in TASK-454) on subprocess crash
  - App-boot health check surfaced in app (Sidebar status dot)

- Out of scope:
  - Any "approve" or "reject" tool inside the MCP server (preserves the product thesis)
  - Tool surfaces beyond the three named (cancel-run, edit-plan, modify-workflow are all explicitly v1.1+)
  - Multi-orchestrator-process MCP federation
  - Tool result caching or query optimization

## Success Signal

A running Claude session inside any Cyboflow workflow can invoke `cyboflow_list_pending_approvals` and see queue state including pending approvals from *other* parallel runs. Killing the MCP subprocess does not corrupt approval flow (the permission bridge is independent). The packaged signed DMG spawns the MCP server correctly from `asar.unpacked`. If the MCP server fails to start at app boot, the Sidebar shows a red dot rather than silently disabling outbound tools.
