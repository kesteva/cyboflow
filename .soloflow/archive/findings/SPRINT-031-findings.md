---
sprint: SPRINT-031
pending_count: 9
last_updated: "2026-05-22T15:31:15.005Z"
---
# Findings Queue

## FIND-SPRINT-031-4
- **source:** TASK-725 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** frontend/src/utils/cyboflowApi.ts:93-102, shared/types/claudeStream.ts:448-457
- **description:** TASK-725 introduced `StreamEnvelopePayload` in `shared/types/claudeStream.ts` as a 9-arm discriminated union pairing each `StreamEventType` with its payload shape. The renderer-side `StreamEvent` discriminated union in `frontend/src/utils/cyboflowApi.ts:93-102` re-declares the same 9 arms, only adding `runId: string` and `timestamp: string` to every arm. This is structural duplication: `StreamEvent` could be expressed as `StreamEnvelope & { runId: string }` (because `StreamEnvelope = StreamEnvelopePayload & { timestamp: string }`). Today, adding a new SDK variant to `ClaudeStreamEvent` requires synchronized edits to (a) `StreamEventType`, (b) `StreamEnvelopePayload`, AND (c) renderer `StreamEvent` — three sites in two files. If the renderer arm is forgotten, TypeScript will narrow incorrectly at the consumer (`RunView.renderEvent`) and the renderer will fall through to `UnknownEventRow` for the new variant.
- **suggested_action:** Refactor `frontend/src/utils/cyboflowApi.ts` to express `StreamEvent` as `StreamEnvelope & { runId: string }` — a one-liner that eliminates the 9-arm duplication and centralizes the discriminated-union source of truth in `shared/types/claudeStream.ts`. Verify by running `pnpm typecheck` and `pnpm --filter frontend test` afterward (the existing 279 frontend tests cover `RunView` rendering for every active arm). Out-of-scope for TASK-725 because `cyboflowApi.ts` is listed in the plan as `files_readonly`; the executor was constrained to a surgical typed-envelope change. This is a natural follow-up cleanup once an unrelated touch lands on that file.
- **resolved_by:** 

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

## FIND-SPRINT-031-5
- **source:** SPRINT-031 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts:34-69
- **description:** Same-sprint convention drift: TASK-720 created approvalCreatedBridge.test.ts with an inline createTestDb() that does `readFileSync(SCHEMA_PATH)` against `main/src/database/migrations/006_cyboflow_schema.sql`, plus its own seedWorkflowAndRun(db, workflowName) helper. TASK-722 then extracted the canonical createTestDb (GATE_SCHEMA, no readFileSync) + seedRun(db, overrides?) into `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` and migrated 3 sibling files (approvalRouter.test.ts, runRecovery.test.ts, approvals.test.ts) to use it. approvalCreatedBridge.test.ts lives in the SAME `__tests__/` directory as those three but was not migrated — TASK-722 cited the 3 files in its plan but apparently missed the file that TASK-720 had just shipped earlier in the same sprint. As a result the shared fixture exists yet a brand-new test file already violates the convention.
- **suggested_action:** Replace the local createTestDb() in approvalCreatedBridge.test.ts with `import { createTestDb, seedRun } from ../__test_fixtures__/orchestratorTestDb`. Adapt seedWorkflowAndRun() to call seedRun() with `workflowName` override (the only column the local helper customizes that seedRun does not already cover by default). The readFileSync(SCHEMA_PATH) + path constant block can then be deleted entirely. Verify with `pnpm --filter main test -- approvalCreatedBridge` after migration. Trivial follow-up clean-up — same pattern TASK-722 already exercised on three sibling files.
- **resolved_by:** 





Suspected tasks: TASK-720, TASK-722

## FIND-SPRINT-031-6
- **source:** SPRINT-031 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts:127-130
- **description:** Same-sprint helper-extraction drift: TASK-721 extracted `truncatePayloadPreview` + `PAYLOAD_PREVIEW_MAX_LEN` into `shared/utils/approvals.ts` (the 512-char cap is now a single source). The bridge production code at `main/src/orchestrator/approvalCreatedBridge.ts:64` and the listPending production code at `main/src/orchestrator/trpc/routers/approvals.ts:86` BOTH consume the helper. However, approvalCreatedBridge.test.ts — created by TASK-720 in the same sprint — still inlines the equivalent at lines 127-130:
- **suggested_action:** In approvalCreatedBridge.test.ts replace the inline truncation in the local `listPending(db)` helper with `truncatePayloadPreview(row.payloadPreviewRaw)` imported from `../../../../shared/utils/approvals`. Single-line change, no behavioral effect. Could ride into the next touch of this test file alongside the createTestDb migration in FIND-SPRINT-031-5.
- **resolved_by:** 




```ts
payloadPreview:
  row.payloadPreviewRaw.length > 512
    ? row.payloadPreviewRaw.slice(0, 512)
    : row.payloadPreviewRaw,
```

The inline literal `512` is exactly the constant the new helper exports. Any future change to `PAYLOAD_PREVIEW_MAX_LEN` will quietly desync the tests parity assertion from production behavior.

Suspected tasks: TASK-720, TASK-721

## FIND-SPRINT-031-7
- **source:** SPRINT-031 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
- **description:** Cross-task incomplete extraction: TASK-722 lifted `createTestDb`/`seedRun` into a shared fixture but stopped at workflow_runs. The companion approvals-row seeding helper is now duplicated across 4+ test files with subtly different signatures:
- **suggested_action:** Extend `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` with a `seedApproval(db, overrides?: { id?: string; runId: string; toolName?: string; toolInputJson?: string; status?: ApprovalStatus; createdAt?: string })` helper that returns the inserted approval id. Migrate the 4+ test files listed above to call it, deleting their local helpers. Add a corresponding `seedApproval` row test in `__test_fixtures__/__tests__/orchestratorTestDb.test.ts` so coverage stays symmetric with `seedRun`. Update CODE-PATTERNS.md to mention `seedApproval` alongside the existing `seedRun` note. Mid-sized task — pre-existing audit: `grep -rn INSERT INTO approvals\|seedPendingApproval\|seedApprovalRow\|seedApproval main/src --include=*.ts`.
- **resolved_by:** 



- main/src/orchestrator/__tests__/runRecovery.test.ts:32 `seedPendingApproval(db, approvalId, runId)` — TASK-722 just migrated this file but did not consolidate this helper.
- main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts:32 `seedApprovalRow(db, approvalId, runId, createdAt)` — TASK-722 migrated this file too; same gap.
- main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts:75 `seedApproval(db, runId, toolName, toolInputJson)` — added by TASK-720 in this sprint with a fourth distinct signature.
- main/src/trpc/__tests__/approvals.test.ts:44 `seedPendingApprovals(db, runId, count)` — pre-existing.
- main/src/orchestrator/__tests__/inspectorQueries.test.ts:99, stuckDetector.test.ts:127 — more inline INSERTs.

A schema change to `approvals` (e.g. adding a NOT NULL column) now requires editing 6+ sites with 4 different helper signatures. This is the same drift class FIND-SPRINT-018-12 captured for `workflow_runs`. TASK-722s plan-decisions could have flagged approvals seeding as an explicit out-of-scope exclusion — leaving it half-extracted creates a worse state than not extracting at all because the new fixture file looks complete but covers only workflow rows.

Suspected tasks: TASK-720, TASK-722

## FIND-SPRINT-031-8
- **source:** SPRINT-031 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts:93-135
- **description:** Cross-task code duplication: the local `listPending(db)` helper inside approvalCreatedBridge.test.ts (added by TASK-720 for round-trip parity testing) is a near-verbatim copy of the production `listPending` procedure in `main/src/orchestrator/trpc/routers/approvals.ts:55-91`. Same SELECT JOIN, same DbApprovalRow shape (renamed to `DbRow` locally), same row.map projection, same inline 512-truncation (see FIND-SPRINT-031-6). The whole point of the parity test is that bridge.workflowName === listPending.workflowName — but if the production listPendings SQL ever changes (e.g. an added ORDER BY tiebreaker, a JOIN on a new approvals_metadata table), the test will keep passing against its stale local clone, silently losing the parity guarantee.
- **suggested_action:** Refactor: extract the pure SELECT-and-shape projection out of `approvalsRouter.listPending` into a standalone exported helper (e.g. `selectPendingApprovals(db: DatabaseLike): Approval[]` in `main/src/orchestrator/approvalListing.ts`) so both the tRPC procedure and the bridge parity test import the same function. The tRPC procedure becomes a one-liner around it. Then delete the local 40-line `listPending(db)` in approvalCreatedBridge.test.ts. Verify with `pnpm --filter main test -- approvalCreatedBridge approvals`. Out-of-scope for TASK-720s narrow workflowName fix but a natural cleanup once anyone touches this test file next.
- **resolved_by:** 


Suspected tasks: TASK-720

## FIND-SPRINT-031-9
- **source:** SPRINT-031 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runLauncher.ts:146-150, main/src/orchestrator/runEventBridge.ts:240-244
- **description:** Cross-task envelope-construction duplication introduced by TASK-724 + TASK-725: the new typed `StreamEnvelope` is now constructed at two distinct sites:

1. `runLauncher.ts:146-150` — synthetic run_started envelope:
   ```ts
   this.publisher?.publish(runId, {
     type: run_started,
     payload: { type: run_started, runId, worktreePath, branchName },
     timestamp: new Date().toISOString(),
   });
   ```

2. `runEventBridge.ts:240-244` — per-SDK-event envelope (the audited boundary cast):
   ```ts
   const envelope = {
     type: deriveEnvelopeType(typed) as StreamEventType,
     payload: typed,
     timestamp: new Date().toISOString(),
   } as StreamEnvelope;
   ```

Both sites manually wire `type` + `payload` + `timestamp`. TASK-725 invested in a 9-arm discriminated union (`StreamEnvelopePayload`) to make the cross-product type-checked, but only #2 benefits from the discriminator — #1 falls outside any audited cast and any future field added to `StreamEnvelope` (e.g. a monotonic sequence number for the renderers gap detection) must be remembered at both sites. With the SDK substrate continuing to grow, additional emit sites are likely.

Suspected tasks: TASK-724, TASK-725
- **suggested_action:** Add a small typed builder in `shared/types/claudeStream.ts` (or `main/src/orchestrator/streamEnvelope.ts`) — e.g. `buildEnvelope<K extends StreamEventType>(type: K, payload: PayloadFor<K>): StreamEnvelope` — that stamps `timestamp` and returns the typed envelope. Use it from runLauncher.ts:146 and runEventBridge.ts:240. The boundary `as StreamEnvelope` cast at runEventBridge stays — `deriveEnvelopeType` returns the discriminator string at runtime — but is now isolated inside the builder, and runLauncher.ts becomes cast-free for run_started emission. Add a unit test fixing the shape (timestamp is ISO, type matches StreamEventType, payload matches the variant). Verify with `pnpm typecheck` + `pnpm --filter main test -- runLauncher runEventBridge cyboflow-stream-publisher`.
- **resolved_by:** 
