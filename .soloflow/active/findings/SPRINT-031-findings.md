---
sprint: SPRINT-031
pending_count: 3
last_updated: "2026-05-22T15:30:00.000Z"
---

# Findings Queue

## FIND-SPRINT-031-3
- **source:** TASK-726 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/ipc/session.ts, main/src/ipc/project.ts, main/src/ipc/git.ts, main/src/ipc/folders.ts, main/src/ipc/panels.ts, main/src/ipc/file.ts, main/src/ipc/script.ts, main/src/ipc/claudePanel.ts, main/src/ipc/dashboard.ts, main/src/ipc/dialog.ts, main/src/ipc/config.ts, main/src/ipc/commitMode.ts, main/src/ipc/uiState.ts, main/src/ipc/logs.ts, main/src/ipc/editorPanel.ts, main/src/ipc/analytics.ts, main/src/ipc/prompt.ts, main/src/ipc/stravu.ts, main/src/ipc/updater.ts, main/src/ipc/nimbalyst.ts, main/src/ipc/baseAIPanelHandler.ts, main/src/ipc/app.ts
- **description:** TASK-726 introduced `validateInput` and documented in `docs/CODE-PATTERNS.md:219-236` that "All `ipcMain.handle` handlers in `main/src/ipc/*.ts` MUST validate args via `validateInput`". Today only `main/src/ipc/cyboflow.ts` (3 handlers) complies. Every other IPC handler file still relies on a positional parameter type annotation (e.g. `async (_event, projectId: string) => …` in `main/src/ipc/project.ts:211,235,295`) which is a compile-time-only contract — the renderer can pass anything and the handler will dereference `undefined`/wrong-type values, potentially throwing inside `better-sqlite3.prepare(...).all(projectId)` or returning empty result sets silently. The new convention is documented but not enforced anywhere across the bulk of the IPC surface.
- **suggested_action:** Either (a) walk each `main/src/ipc/*.ts` file and migrate the `(_event, x: T)` parameter style to a single `args: unknown` + `validateInput(...)` call, OR (b) add a grep-gate in CI that blocks new `ipcMain.handle(...)` registrations whose handler signature has more than `(_event, args: unknown)`. Given the scale (20+ files, ~150 handlers), this is a multi-task epic — likely split per domain. Pre-existing audit: `grep -nE "ipcMain\.handle\([^,]+,\s*async?\s*\(_?event,\s*[a-zA-Z]+:\s*[^u]" main/src/ipc/*.ts` returns roughly the violation set.
- **resolved_by:**

## FIND-SPRINT-031-2
- **source:** TASK-726 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/ipc/__tests__/cyboflow.test.ts:526, main/src/ipc/__tests__/cyboflow.test.ts:543
- **description:** Two comment lines still reference the now-deleted helpers: `// validateNumberArg — !Number.isFinite branch (NaN / Infinity)` (line 526) and `// validateStringArg — v.length === 0 branch` (line 543). The tests themselves are correct (they exercise the same code paths through the new `validateInput`), but the comments are now misleading — a future reader will grep for `validateNumberArg` and land here only to find no such function exists.
- **suggested_action:** Rewrite the two comments to describe the branch in `validateInput` terms, e.g. `// validateInput — z.number().finite() rejects NaN/Infinity` and `// validateInput — z.string().min(1) rejects empty string`. Trivial single-commit cleanup; could ride into the next test-file touch on this module.
- **resolved_by:**

## FIND-SPRINT-031-1
- **source:** TASK-720 (verifier)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/approvalRouter.ts:181-188, main/src/orchestrator/approvalCreatedBridge.ts:79
- **description:** Secondary data drift between the SSE bridge and listPending on the `createdAt` field, same family as the workflowName drift TASK-720 just fixed. `ApprovalRouter.requestApproval` computes two near-but-not-equal timestamps: `now = new Date().toISOString()` (stored in `approvals.created_at`) and `request.timestamp = Date.now()` (carried in the in-memory ApprovalRequest). The bridge then computes `new Date(request.timestamp).toISOString()` for the SSE event's `createdAt`, while listPending reads `a.created_at` directly. The two ISO strings differ by the few-microsecond gap between the two `Date.*` calls. Renderer reconcilers that key on `createdAt` (or any test that does byte-equality) will see a phantom mismatch between the SSE-pushed Approval and the listPending row for the same DB id.
- **suggested_action:** Either (a) populate `request.timestamp` from the same `now` value used in the INSERT (single source of truth), or (b) make the bridge re-read `a.created_at` from the DB along with the workflowName JOIN. Option (a) is the simpler fix and keeps the bridge pure. TASK-720 narrowly fixed workflowName; this is the sibling drift the same compound proposal could have caught.
- **resolved_by:**

