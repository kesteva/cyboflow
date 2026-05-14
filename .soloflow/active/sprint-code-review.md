---
sprint: SPRINT-006
findings_count:
  critical: 1
  important: 5
  minor: 5
---

# Sprint Code Review: SPRINT-006

## Scope
- Base: 0d0a927d60d9debaeef2dd28b0482cd653ce0c6e
- Tasks reviewed: [TASK-251, TASK-252, TASK-253, TASK-254, TASK-255, TASK-301, TASK-302]
- Files changed: 18 source files (excl. .soloflow state)
- Cross-task hotspots:
  - main/src/index.ts (touched by TASK-255 + TASK-301 + TASK-302 — orchestrator wiring + permission server rename + ApprovalRouter init)
  - main/src/services/cyboflowPermissionIpcServer.ts (TASK-301 rename + TASK-302 ApprovalRouter integration)
  - main/src/services/cyboflowPermissionBridge.ts (TASK-301 rename + TASK-302 ApprovalDecision retype)
  - main/src/services/panels/claude/claudeCodeManager.ts (TASK-301 rename + TASK-302 swap PermissionManager → ApprovalRouter)
  - main/src/orchestrator/approvalRouter.ts (TASK-302; depends on TASK-253 DatabaseLike + TASK-252 RunQueueRegistry types)

## Findings queued

11 new findings appended to `.soloflow/active/findings/SPRINT-006-findings.md` for the next `/soloflow:compound` run. Severity breakdown of NEW findings only: critical=1, important=5, minor=5.

### Critical (1)
- FIND-SPRINT-006-15 — Socket-message framing: both bridge and IPC server JSON.parse() a single net `data` event as if it were a complete JSON frame; chunk coalescing/splitting wedges a workflow run in `awaiting_review` because the new ApprovalRouter persists state before the reply lands.

### Important (5)
- FIND-SPRINT-006-14 — Startup race: `CyboflowPermissionIpcServer.start()` runs in `initializeServices()` (line 571) while `ApprovalRouter.initialize()` runs in the post-`createWindow()` block (line 715); any inbound request during that window throws on `ApprovalRouter.getInstance()`.
- FIND-SPRINT-006-16 — No input validation in `cyboflowPermissionIpcServer.ts:53-89`; raw socket bytes flow straight into `ApprovalRouter.requestApproval` and into `JSON.stringify(input)` persisted into `approvals.tool_input_json`.
- FIND-SPRINT-006-17 — Dead code: `main/src/services/permissionManager.ts` and `main/src/services/mcpPermissionServer.ts` have zero importers but were touched by TASK-301 (rename inside mcpPermissionServer) — looks freshly maintained while being orphaned.
- FIND-SPRINT-006-18 — `OrchestratorDeps.eventBus` is wired through every layer but read by nothing; ApprovalRouter emits on its own EventEmitter instead of the shared bus; events router uses placeholder iterators.
- FIND-SPRINT-006-19 — Identifier conflation: `sessionId` (bridge argv) == `runId` (ApprovalRouter) == fabricated `tool_use_id` (in DB) — three concepts collapsed into one transitional UUID; schema invariant on `approvals.tool_use_id` is silently broken until TASK-304.

### Minor (5)
- FIND-SPRINT-006-20 — Unix socket file at `~/.cyboflow/sockets/cyboflow-permissions-<pid>.sock` is not chmod 0o600; parent dir is not chmod 0o700.
- FIND-SPRINT-006-21 — Invalid tRPC error code `NOT_IMPLEMENTED` used in all three stub sub-routers; should be `METHOD_NOT_SUPPORTED`, and the stub pattern should be a shared helper.
- FIND-SPRINT-006-22 — `crystalDirectory.ts:81-87` alias docstring describes a directory flip that has already happened in the same file; rename the underlying functions or correct the docstring.
- FIND-SPRINT-006-23 — `main/build-cyboflow-permission-bridge.js` duplicates `cyboflowPermissionBridge.ts` logic with a hand-rolled SimpleMCPServer; the two implementations have already drifted (the standalone version correctly buffers/splits stdin lines; the TS source does not).
- FIND-SPRINT-006-24 — `${Date.now()}-${Math.random()}` request-ID pattern duplicated in `cyboflowPermissionBridge.ts:31` and `cyboflowPermissionIpcServer.ts:45`; the same sprint already imports `randomUUID` from `node:crypto` in `approvalRouter.ts:30`.

(The 12 pre-existing findings carried over from per-task review are not re-summarized here — see the findings file for full detail.)
