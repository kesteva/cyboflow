---
sprint: SPRINT-034
pending_count: 2
last_updated: "2026-05-23T20:05:00Z"
---

# Findings Queue
TASK-555 gated: failing blocking prereq (notarytool credentials missing).

## FIND-SPRINT-034-2
- **source:** TASK-620 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** shared/types/mcpHealth.ts:36
- **description:** `HEALTH_STARTING` is exported as a plain `McpServerHealth` const (not `Readonly<McpServerHealth>` or `Object.freeze`'d). Both call sites (`main/src/ipc/cyboflow.ts:211` and `main/src/orchestrator/trpc/routers/health.ts:46`) `return HEALTH_STARTING` directly — every caller receives the same object reference. A future consumer that mutates the response would corrupt the shared singleton globally, with no compile-time warning. Today both consumers are read-only, so this is latent; flagging now so the next contact gives it a `Readonly<McpServerHealth>` annotation or `Object.freeze`.
- **suggested_action:** Either annotate as `export const HEALTH_STARTING: Readonly<McpServerHealth> = Object.freeze({ status: 'starting', restartAttempts: 0 });` or wrap each call site to return a shallow clone (`return { ...HEALTH_STARTING };`). The frozen-readonly approach is preferred (cheaper, type-checked).
- **resolved_by:**

## FIND-SPRINT-034-1
- **source:** TASK-617 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:19
- **description:** Header docstring still says "use an in-memory better-sqlite3 instance initialised with the imported GATE_SCHEMA fixture", but TASK-617 replaced that import with an inline `MINIMAL_SCHEMA` const (see line 38). The docstring now misdescribes the fixture and references an import that is no longer present. Future readers grepping for `GATE_SCHEMA` will hit this stale comment plus the line-31 "Mirrors the relevant subset of REGISTRY_SCHEMA + GATE_SCHEMA" comment (which is still accurate-as-prose, but the line-19 sentence is not).
- **suggested_action:** Update line 19 to "All tests use an in-memory better-sqlite3 instance initialised with the inline `MINIMAL_SCHEMA` const declared below (no real migration runner — tests are hermetic)."
- **resolved_by:**

