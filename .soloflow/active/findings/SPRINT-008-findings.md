---
sprint: SPRINT-008
pending_count: 3
last_updated: "2026-05-14T23:15:19.579Z"
---
# Findings Queue

- override: gating-prereqs
  task: TASK-595
  reason: "Prereq probes at sprint-init are checking files that TASK-587/590/591/592/593 will produce within this sprint; TASK-595 depends_on TASK-591 + TASK-594 (DAG enforces ordering), and TASK-595's own plan step 1 re-runs the prereq checks at executor time. Gating now would defeat the sprint's terminal smoke step."
  applied_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)

## FIND-SPRINT-008-1
- **source:** TASK-588 (verifier)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main package — better-sqlite3 native binding
- **description:** better-sqlite3 prebuilt binary at node_modules/.pnpm/better-sqlite3@11.10.0/.../better_sqlite3.node is built for NODE_MODULE_VERSION 137 but the active Node runtime requires 127. This blocks every vitest case in main/src/orchestrator/__tests__/approvalRouter.test.ts from running (8/8 fail at db construction time). Reproduces identically on `main` pre-commit — pre-existing, not introduced by TASK-588. CLAUDE.md documents the fix (`pnpm electron:rebuild`).
- **suggested_action:** Run `pnpm electron:rebuild` from the repo root. Re-run `cd main && pnpm test -- approvalRouter` to confirm the 8 tests pass with case count preserved.

## FIND-SPRINT-008-2
- **source:** TASK-590 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:372-376
- **description:** `composeMcpServers()` casts the base-project MCP server record to `Record<string, { type?: 'stdio'; command: string; args?: string[] }>`, which is narrower than the SDK's `McpStdioServerConfig` (drops `env`, `alwaysLoad`) and only covers stdio — not SSE/HTTP/SDK variants. Runtime values pass through `Object.assign` untouched, so SSE/HTTP/`env` fields will reach the SDK; the cast is type-only. But the narrowed type makes future maintainers think only stdio servers are accepted, and a future strictly-typed assignment would silently drop `env`. The SDK already exports `McpServerConfig` (union of all variants) — preferable to type the return as `Record<string, McpServerConfig>` and let the SDK validate at the boundary.
- **suggested_action:** Replace the cast on line 375 with `return mcpServers as Record<string, import('@anthropic-ai/claude-agent-sdk').McpServerConfig>;` (or import the type at the top of the file). Update the return-type annotation on line 372 to match. No runtime change.

## FIND-SPRINT-008-3
- **source:** TASK-590 (verifier)
- **type:** improvement
- **severity:** low
- **location:** main/src/services/panels/claude/claudeCodeManager.ts:438-442, 447-453
- **status:** open
- **description:** `killProcess()` short-circuits via `abortCurrentRun()` which returns early (`if (!run) return;`) when no SDK run is active for the panel. The early-return path skips `cleanupCliResources(sessionId)`, so `ApprovalRouter.getInstance().clearPendingForRun(sessionId)` is NOT called when killProcess is invoked on a panel without an active SDK run. The pre-SDK substrate also had this behavior (you could only kill a running process), so this is parity-preserving. However, callers like `restartPanelWithHistory` (line 550-560) call killProcess defensively before spawning — if any path drops a `requestApproval` promise without consuming it, the pending row could leak across the restart. Worth a future review when the approval lifecycle is touched again.
- **suggested_action:** None for v1 — defer until approval-lifecycle gets a dedicated cleanup audit. Note in the EPIC follow-up list.

## FIND-SPRINT-008-4
- **source:** TASK-590 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** resolved
- **location:** main/src/orchestrator/approvalRouter.ts (callsite contract) + main/src/services/cyboflowPermissionIpcServer.ts:73-78 + main/src/services/panels/claude/claudeCodeManager.ts:143,394
- **description:** Two different IDs are passed as `runId` to ApprovalRouter depending on the codepath. The legacy bridge path (`cyboflowPermissionIpcServer.ts`) calls `requestApproval(sessionId, ...)` — runId = Crystal sessionId. The new SDK path (`claudeCodeManager.ts:394`) calls `requestApproval(panelId, ...)` — runId = panelId. Critically, in the same SDK file, `cleanupCliResources(sessionId)` calls `clearPendingForRun(sessionId)` — using a DIFFERENT id from what `requestApproval` was called with. Currently masked because `clearPendingForRun` is a documented stub (no-op), but when TASK-304 implements its full body, the SDK path will fail to clean up pending approvals on run termination because it's looking for entries under `sessionId` while they're indexed by `panelId`. ApprovalRouter's docstring also doesn't pin down which one is canonical, leaving the contract ambiguous for the next consumer.
- **suggested_action:** Pick one canonical convention (panelId, since that matches workflow_runs.id semantics per the @cyboflow-hidden comment), update ApprovalRouter to document it, change `cyboflowPermissionIpcServer.ts` to pass panelId (the IPC bridge will be removed by TASK-580+ but the inconsistency should be fixed first or removed together), and in `claudeCodeManager.ts` change `cleanupCliResources` so it calls `clearPendingForRun(panelId)` not `clearPendingForRun(sessionId)`. Best aligned with TASK-304 (clearPendingForRun implementation) since the convention must be settled before that body is written.
- **resolved_by:** TASK-590
