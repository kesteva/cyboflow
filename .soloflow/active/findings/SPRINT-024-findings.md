---
sprint: SPRINT-024
pending_count: 5
last_updated: "2026-05-20T05:35:00.000Z"
---
# Findings Queue

## FIND-SPRINT-024-1
- **source:** TASK-634 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts:635,816,871,1310
- **description:** 4 pre-existing test failures in runExecutor.test.ts: lifecycle-transition spy called-once assertions fail (got 2 calls), bridgeEvents short-circuit not-called assertion fails. Not related to TASK-634 changes — failures present on the branch before this task.
- **suggested_action:** Investigate runExecutor or its mocks for state bleeding between tests (spy not being reset); may need a clearAllMocks in beforeEach.
- **resolved_by:** 

## FIND-SPRINT-024-2
- **source:** TASK-634 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:680
- **description:** Pre-existing test failure: rebuilds the table when worktree_path is NOT NULL or stuck_detected_at orphan column exists — assertion `expect(cols.some((c) => c.name === stuck_detected_at)).toBe(false)` fails (column still present after rebuild). Not caused by TASK-634 changes.
- **suggested_action:** Investigate the schema migration / reconciler that should drop stuck_detected_at; the rebuild path may not be removing it.
- **resolved_by:** 

## FIND-SPRINT-024-3
- **source:** TASK-634 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/workflowRegistry.test.ts:20-21
- **description:** Duplicate import of the `path` module — line 20 has `import { join } from 'path'` and line 21 has `import * as path from 'path'`. Both are used (line 20's `join` 17 times; namespace `path.relative` and `path.join` on lines 572,578). Predates TASK-634 (already present in 5c08a56^) but the executor touched this import block while removing `mkdtempSync` and `tmpdir`, and had the opportunity to collapse to a single namespace import.
- **suggested_action:** Collapse to a single `import * as path from 'path'` and rewrite the 17 `join(...)` callsites to `path.join(...)`, OR drop the namespace import and inline `path.relative` as `relative` from `'path'` alongside `join`. Optional — both imports work and the dual-import idiom is not strictly broken.
- **resolved_by:** 

## FIND-SPRINT-024-4
- **source:** TASK-637 (code-reviewer)
- **type:** anti-pattern
- **severity:** high
- **status:** open
- **location:** frontend/src/types/electron.d.ts:86,317 and frontend/src/utils/api.ts:90,520
- **description:** The IPC declaration `getJsonMessages: (panelId: string) => Promise<IPCResponse<ClaudeJsonMessage[]>>` is stale. At runtime the `panels:get-json-messages` handler in `main/src/ipc/session.ts:937` returns `UnifiedMessage[]` (built by `projectStoredOutputs` → `MessageProjection`). The two shapes are incompatible: `ClaudeJsonMessage` has `type`/`message`/`data`/etc.; `UnifiedMessage` has `role`/`segments`/`metadata`. This type lie is what forced the original `as unknown as JSONMessage[]` and `as unknown as UserPromptMessage[]` double-casts in MessagesView/RichOutputView, and it caused TASK-637's adapter refactor to introduce a runtime regression (parseJsonMessage was designed against ClaudeJsonMessage but receives UnifiedMessage in practice). The same mismatch applies to the legacy `sessions:get-json-messages` handler.
- **suggested_action:** Change both `getJsonMessages` IPC type declarations from `IPCResponse<ClaudeJsonMessage[]>` to `IPCResponse<UnifiedMessage[]>` (import from `shared/types/unifiedMessage`). Then redesign `parseJsonMessage` against the real UnifiedMessage shape (discriminate on `role` + `metadata.systemSubtype`, not `type`/`message`/`data`). The simpler immediate fix is to drop the parseJsonMessage adapter entirely and feed `outputResponse.data` straight into `messageTransformer.transform()` (which is a passthrough cast to `UnifiedMessage[]`).
- **resolved_by:** 

## FIND-SPRINT-024-5
- **source:** TASK-637 (verifier)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** frontend/src/components/panels/ai/MessagesView.tsx:39-49
- **description:** The fix commit bb926cd hard-codes `setSessionInfo(null)` in the initial-load path of MessagesView.tsx, dropping session_info detection from `panels:get-json-messages` payload. In practice this preserves pre-existing behavior (the prior baseline code's `'type' in msgData && msgData.type === 'session_info'` check was already dead against UnifiedMessage shape because UnifiedMessage uses `role` not `type`, so foundSessionInfo never matched), so this is NOT a user-visible regression on the load path. However, the realtime `session:output` handler (lines 67-119) still has session_info detection logic that may also be dead/stale against current message shapes — its `parsedData.type === 'session_info'` check looks for a Crystal-era shape that may not be emitted by the current Electron app. Worth verifying whether the MessagesView Session Information card has ever rendered post-UnifiedMessage migration, or whether the entire feature should be reworked to drive off UnifiedMessage metadata.systemSubtype === 'init' like RichOutputView does (line 764).
- **suggested_action:** When FIND-SPRINT-024-4 is addressed (correcting the IPC type to UnifiedMessage), also redesign MessagesView's Session Information card to read from the system init UnifiedMessage (`role === 'system' && metadata.systemSubtype === 'init'` carries `metadata.sessionInfo`). Keep the current `setSessionInfo(null)` hard-code as a TODO until the rework lands.
- **resolved_by:** 

## FIND-SPRINT-024-6
- **type:** scope_deviation
- **source:** TASK-646 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/__tests__/runExecutor.test.ts
- **description:** required to meet AC: sweep-grep gate AC requires all orchestrator test files to use shared fixture; runExecutor.test.ts has a local makeLogger() that would violate the completeness gate. Claimed to migrate it alongside the other 6 identified files.
- **resolved_by:** verifier — plan-prescribed: Implementation Step 1 ("Add any missed sites to files_owned") + AC-prescribed: sweep-grep gate AC4 would fail without this migration

## FIND-SPRINT-024-7
- **type:** scope_deviation
- **source:** TASK-646 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/__tests__/preToolUseHookHelper.test.ts
- **description:** required to meet AC: sweep-grep gate AC requires all orchestrator test files to use shared fixture; preToolUseHookHelper.test.ts has a local makeLogger() that would violate the completeness gate. Claimed to migrate it alongside the other 6 identified files.
- **resolved_by:** verifier — plan-prescribed: Implementation Step 1 ("Add any missed sites to files_owned") + AC-prescribed: sweep-grep gate AC4 would fail without this migration
