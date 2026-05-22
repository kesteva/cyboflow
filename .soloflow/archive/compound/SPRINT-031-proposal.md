---
sprints: [SPRINT-031]
span_label: SPRINT-031
created: 2026-05-22T00:00:00.000Z
counters_start:
  ideas: 24
summary:
  cleanups: 5
  backlog_tasks: 4
  claude_md: 2
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-031

## A. Clean-up items (execute now)

### A1. Remove stale validateNumberArg / validateStringArg comments from cyboflow.test.ts
- **Summary:** Two test comments in `cyboflow.test.ts` reference deleted helpers (`validateNumberArg`, `validateStringArg`) after TASK-726 replaced them with a single `validateInput` function — misleading any reader who greps for the old names.
- **Source-Sprint:** SPRINT-031
- **Rationale:** The tests themselves are correct but the comments describe non-existent functions. A future maintainer grepping for `validateNumberArg` will land here and find nothing, wasting time. Two-line rewrite with zero risk.
- **Blast radius:** `main/src/ipc/__tests__/cyboflow.test.ts` lines 526 and 543 only. Risk: trivial.
- **Source:** FIND-SPRINT-031-2 (code-reviewer on TASK-726)
- **Proposed change:**
  ```diff
  - // validateNumberArg — !Number.isFinite branch (NaN / Infinity)
  + // validateInput — z.number().finite() rejects NaN/Infinity

  - // validateStringArg — v.length === 0 branch
  + // validateInput — z.string().min(1) rejects empty string
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed both comments still reference deleted helpers at `main/src/ipc/__tests__/cyboflow.test.ts:526` and `:543` while no `validateNumberArg`/`validateStringArg` symbols exist anywhere in `main/src/ipc/`; two-line edit, zero behavioral risk.

---

### A2. Migrate approvalCreatedBridge.test.ts to the shared orchestratorTestDb fixture
- **Summary:** `approvalCreatedBridge.test.ts` (added by TASK-720 in this sprint) still inlines its own `createTestDb` + `readFileSync(SCHEMA_PATH)` block despite TASK-722 (same sprint) extracting `createTestDb`/`seedRun` into `orchestratorTestDb.ts` and migrating the three sibling files in the same `__tests__/` directory.
- **Source-Sprint:** SPRINT-031
- **Rationale:** This is the same sweep TASK-722 performed on `approvalRouter.test.ts`, `runRecovery.test.ts`, and `approvals.test.ts` — all four files live in `main/src/orchestrator/__tests__/`. Leaving one un-migrated file means a schema change to `workflow_runs` still requires editing `approvalCreatedBridge.test.ts` separately. The migration is mechanical and already proved out by TASK-722.
- **Blast radius:** `main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts` only. Verify with `pnpm --filter main test -- approvalCreatedBridge`. Risk: low.
- **Source:** FIND-SPRINT-031-5 (sprint-code-reviewer, suspected TASK-720 + TASK-722)
- **Proposed change:**
  ```diff
  - import { readFileSync } from 'fs';
  - import path from 'path';
  - const SCHEMA_PATH = path.join(__dirname, '../../../database/migrations/006_cyboflow_schema.sql');
  - function createTestDb() {
  -   const db = new Database(':memory:');
  -   db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));
  -   return db;
  - }
  - function seedWorkflowAndRun(db, workflowName: string) { /* ... */ }
  + import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
  ```
  Adapt the `seedWorkflowAndRun(db, workflowName)` calls to `seedRun(db, runId, { workflowName })` — the shared fixture's `seedRun` already accepts an overrides object. The `SCHEMA_PATH` constant block and the `readFileSync` import can then be deleted entirely.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `approvalCreatedBridge.test.ts:34-44` still inlines `readFileSync(SCHEMA_PATH)` + local `createTestDb` while the canonical `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` already exports `createTestDb` + `seedRun` (with `workflowName` override at line 43) and three sibling tests in the same directory already use it; this is the missing fourth sweep of an already-proven migration.

---

### A3. Replace inline 512-truncation in approvalCreatedBridge.test.ts with the shared helper
- **Summary:** The local `listPending(db)` helper in `approvalCreatedBridge.test.ts` inlines `row.payloadPreviewRaw.length > 512 ? row.payloadPreviewRaw.slice(0, 512) : row.payloadPreviewRaw` — a literal copy of the `PAYLOAD_PREVIEW_MAX_LEN` constant that TASK-721 (same sprint) extracted to `shared/utils/approvals.ts`.
- **Source-Sprint:** SPRINT-031
- **Rationale:** The inline `512` literal will silently diverge if `PAYLOAD_PREVIEW_MAX_LEN` is ever changed — the parity test between the SSE bridge and `listPending` is precisely the guard that should stay in sync. One-line change; rides naturally into the same touch as A2.
- **Blast radius:** `main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts` lines 127–130. Risk: trivial.
- **Source:** FIND-SPRINT-031-6 (sprint-code-reviewer, suspected TASK-720 + TASK-721)
- **Proposed change:**
  ```diff
  - payloadPreview:
  -   row.payloadPreviewRaw.length > 512
  -     ? row.payloadPreviewRaw.slice(0, 512)
  -     : row.payloadPreviewRaw,
  + payloadPreview: truncatePayloadPreview(row.payloadPreviewRaw),
  ```
  Add at the top of the file:
  ```diff
  + import { truncatePayloadPreview } from '../../../../shared/utils/approvals';
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed the inline `row.payloadPreviewRaw.length > 512` check at `approvalCreatedBridge.test.ts:127-130` literally duplicates `PAYLOAD_PREVIEW_MAX_LEN` (= 512) from `shared/utils/approvals.ts:2`, and production sibling `approvalCreatedBridge.ts:64` already uses `truncatePayloadPreview` — the parity test silently desyncs from production if the constant changes.

---

### A4. Express renderer StreamEvent as StreamEnvelope & { runId: string } to eliminate 9-arm duplication
- **Summary:** `frontend/src/utils/cyboflowApi.ts` manually re-declares all 9 arms of the `StreamEnvelopePayload` discriminated union that TASK-725 already centralised in `shared/types/claudeStream.ts` — three new SDK variants would require synchronized edits to three separate sites.
- **Source-Sprint:** SPRINT-031
- **Rationale:** Adding a new SDK event variant today requires touching (a) `StreamEventType`, (b) `StreamEnvelopePayload`, and (c) the renderer `StreamEvent` — three sites in two files. FIND-SPRINT-031-4 notes that if the renderer arm is forgotten, TypeScript narrows incorrectly at `RunView.renderEvent` and falls through to `UnknownEventRow` silently. The refactor is a one-line type alias that eliminates the duplication and makes omission a compile error. The finding explicitly marks this as a "natural follow-up cleanup"; the 279 existing frontend tests already cover the rendering paths.
- **Blast radius:** `frontend/src/utils/cyboflowApi.ts` lines 93–102 (type alias replacement). Verify with `pnpm typecheck` and `pnpm --filter frontend test`. Risk: low.
- **Source:** FIND-SPRINT-031-4 (code-reviewer on TASK-725)
- **Proposed change:**
  ```diff
  - export type StreamEvent =
  -   | { type: 'run_started'; payload: { type: 'run_started'; runId: string; ... }; runId: string; timestamp: string }
  -   | { type: 'message_start'; payload: ...; runId: string; timestamp: string }
  -   | /* ... 7 more arms ... */
  + export type StreamEvent = StreamEnvelope & { runId: string };
  ```
  Import `StreamEnvelope` from `shared/types/claudeStream.ts`. The 9-arm literal block and any import of individual payload types no longer needed in this file can be removed. Run `pnpm typecheck` and `pnpm --filter frontend test` to confirm the 279 existing tests remain green.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `frontend/src/utils/cyboflowApi.ts:93-102` re-declares all 9 arms with `runId`/`timestamp` while `shared/types/claudeStream.ts:448-457` defines the identical 9-arm `StreamEnvelopePayload` and line 471 already exports `StreamEnvelope = StreamEnvelopePayload & { timestamp: string }` — the derived-alias collapses cleanly to a one-line type expression.

---

### A5. Fix createdAt timestamp drift in ApprovalRouter — use one Date source for both DB INSERT and in-memory request
- **Summary:** `ApprovalRouter.requestApproval` computes `now = new Date().toISOString()` for the DB `created_at` column and separately `request.timestamp = Date.now()` for the in-memory `ApprovalRequest`, producing two ISO strings that differ by a few microseconds — causing phantom mismatches between the SSE-pushed `Approval` and the `listPending` row for the same DB id.
- **Source-Sprint:** SPRINT-031
- **Rationale:** The SSE bridge derives `createdAt` from `new Date(request.timestamp).toISOString()` while `listPending` reads `a.created_at` directly from the DB — two conversions of two separate `Date.*` calls. Any renderer reconciler or test asserting byte-equality on `createdAt` will see a phantom difference. TASK-720 fixed the sibling `workflowName` drift in the same function; this is the companion cleanup. Option (a) from the finding (single `now` source) is the minimal fix.
- **Blast radius:** `main/src/orchestrator/approvalRouter.ts` lines 181–188 (one variable reuse). Risk: low.
- **Source:** FIND-SPRINT-031-1 (verifier on TASK-720)
- **Proposed change:**
  ```diff
  - const now = new Date().toISOString();
  - // ... DB INSERT using now ...
  - const request: ApprovalRequest = {
  -   ...
  -   timestamp: Date.now(),
  -   ...
  - };
  + const now = new Date().toISOString();
  + // ... DB INSERT using now ...
  + const request: ApprovalRequest = {
  +   ...
  +   timestamp: new Date(now).getTime(),  // single source: same instant as the DB row
  +   ...
  + };
  ```
  Alternatively: store `const nowMs = Date.now()` once, use `new Date(nowMs).toISOString()` for the DB INSERT and `nowMs` for `request.timestamp`. Either way the key is a single clock read. Verify with `pnpm --filter main test -- approvalCreatedBridge approvalRouter`.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed two independent clock reads at `approvalRouter.ts:181` (`new Date().toISOString()` for DB) and `:188` (`Date.now()` for request.timestamp); the bridge re-converts the latter to ISO at `approvalCreatedBridge.ts:74` while listPending reads the former from DB, producing a few-microsecond divergence on the `createdAt` field for the same row — same drift family as the workflowName drift TASK-720 just fixed, with a one-variable-reuse fix.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Migrate all remaining IPC handler files to validateInput (20+ files, ~150 handlers)
- **Summary:** TASK-726 introduced `validateInput` and documented it as mandatory in `docs/CODE-PATTERNS.md`, but only the 3 handlers in `main/src/ipc/cyboflow.ts` comply — all other IPC files still use positional parameter type casts that provide zero runtime protection.
- **Source-Sprint:** SPRINT-031
- **Source:** FIND-SPRINT-031-3 (code-reviewer on TASK-726)
- **Problem:** Every IPC handler file outside `cyboflow.ts` uses `async (_event, projectId: string) => …` style — a compile-time-only contract. The renderer can pass `undefined` or wrong-type values and the handler either throws inside `better-sqlite3.prepare(...).all(projectId)` or silently returns wrong results. FIND-SPRINT-031-3 identifies 22 files: `session.ts`, `project.ts`, `git.ts`, `folders.ts`, `panels.ts`, `file.ts`, `script.ts`, `claudePanel.ts`, `dashboard.ts`, `dialog.ts`, `config.ts`, `commitMode.ts`, `uiState.ts`, `logs.ts`, `editorPanel.ts`, `analytics.ts`, `prompt.ts`, `stravu.ts`, `updater.ts`, `nimbalyst.ts`, `baseAIPanelHandler.ts`, `app.ts`. Pre-existing audit grep: `grep -nE "ipcMain\.handle\([^,]+,\s*async?\s*\(_?event,\s*[a-zA-Z]+:\s*[^u]" main/src/ipc/*.ts`.
- **Proposed direction:** Treat this as a multi-task epic, splitting by domain (e.g. one task per logical grouping: session+project, git+folders, panels+panels-related, config+uiState, etc.). Each task: (1) grep the file for `ipcMain.handle` registrations, (2) convert each handler signature from `(_event, x: T)` to `(_event, args: unknown)` + `validateInput(z.object({...}), args, 'channel:name')`, (3) propagate the narrowed value through the handler body, (4) run `pnpm typecheck` and `pnpm --filter main test` to confirm no regressions. As a guard rail, consider adding a CI grep-gate that blocks new `ipcMain.handle` registrations whose handler signature has more than one `args: unknown` parameter, enforcing the convention going forward. The canonical pattern is in `main/src/ipc/cyboflow.ts` and documented in `docs/CODE-PATTERNS.md:221-234`.
- **Scope:** large (22 files, ~150 handlers; best done as 4–6 sequential tasks)

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The 97 violation hits across ~22 legacy Crystal-era IPC files are largely outside the cyboflow v1 critical path (most are session/git/panels/claudePanel surfaces that the renderer cutover work in IDEA-023 and the broader CLI panel consolidation will reshape); committing 4-6 sequential mechanical tasks to retrofit `validateInput` onto Crystal scaffolding ahead of the renderer-cutover and v1 surface trimming risks paving over code that's about to be deleted or restructured, and the existing CODE-PATTERNS.md rule already directs new handlers to the canonical pattern so the policy is in place without the bulk migration.
- **Counterfactual:** Concrete evidence that a renderer-passed `undefined`/wrong-type value has caused a real production crash or silent wrong-row return in one of these legacy handlers — or a narrower scope limited to the active cyboflow.* surfaces only — would flip this to IMPLEMENT.

---

### B2. Extract shared seedApproval fixture and consolidate 6 divergent approval seeding helpers
- **Summary:** Six test files seed the `approvals` table using four different helper signatures — a schema change to `approvals` now requires editing 6+ sites, creating the same drift problem `TASK-722` just solved for `workflow_runs`.
- **Source-Sprint:** SPRINT-031
- **Source:** FIND-SPRINT-031-7 (sprint-code-reviewer, suspected TASK-720 + TASK-722)
- **Problem:** `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` (created by TASK-722) is the canonical fixture host for `workflow_runs` but stops there. Approval seeding is fragmented:
  - `runRecovery.test.ts:32` — `seedPendingApproval(db, approvalId, runId)` (3-arg)
  - `trpc/routers/__tests__/approvals.test.ts:32` — `seedApprovalRow(db, approvalId, runId, createdAt)` (4-arg)
  - `approvalCreatedBridge.test.ts:75` — `seedApproval(db, runId, toolName, toolInputJson)` (4-arg, different shape)
  - `trpc/__tests__/approvals.test.ts:44` — `seedPendingApprovals(db, runId, count)` (bulk-insert form)
  - `inspectorQueries.test.ts:99`, `stuckDetector.test.ts:127` — inline `INSERT INTO approvals` literals
  
  As FIND-SPRINT-031-7 notes: "TASK-722's plan-decisions could have flagged approvals seeding as an explicit out-of-scope exclusion — leaving it half-extracted creates a worse state than not extracting at all because the new fixture file looks complete but covers only workflow rows."
- **Proposed direction:** Extend `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` with a `seedApproval(db, overrides?: { id?: string; runId: string; toolName?: string; toolInputJson?: string; status?: ApprovalStatus; createdAt?: string }): string` helper (returns inserted approval id). Migrate all 6 sites to call it. Add a `seedApproval` row test in `__test_fixtures__/__tests__/orchestratorTestDb.test.ts` (symmetric with the existing `seedRun` test). Update `docs/CODE-PATTERNS.md` to mention `seedApproval` alongside `seedRun` in the "Database seed helpers" section (also updating the stale "pending — see compounded FIND-SPRINT-018-12" heading now that TASK-722 has landed). Audit grep: `grep -rn "INSERT INTO approvals\|seedPendingApproval\|seedApprovalRow\|seedApproval" main/src --include="*.ts"`.
- **Scope:** medium (6 call sites, 1 new fixture function, 1 new fixture test, 1 CODE-PATTERNS.md update)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed 4 divergent helper signatures (`seedPendingApproval` at `runRecovery.test.ts:32`, `seedApprovalRow` at `trpc/routers/__tests__/approvals.test.ts:32`, `seedApproval` at `approvalCreatedBridge.test.ts:75`, `seedPendingApprovals` at `trpc/__tests__/approvals.test.ts:44`) plus inline INSERTs at `inspectorQueries.test.ts:107` and `stuckDetector.test.ts:127`; the canonical fixture file already exists with the symmetric `seedRun` shape, so this is a direct extension of the proven TASK-722 pattern that prevents the same drift class for `approvals` schema changes.

---

### B3. Extract selectPendingApprovals helper so the tRPC router and bridge parity test share the same SQL
- **Summary:** The `listPending(db)` helper in `approvalCreatedBridge.test.ts` is a 40-line near-verbatim clone of the production `approvalsRouter.listPending` procedure — if the production SQL changes, the parity test keeps passing against its stale local copy and silently loses the very guarantee it exists to enforce.
- **Source-Sprint:** SPRINT-031
- **Source:** FIND-SPRINT-031-8 (sprint-code-reviewer, suspected TASK-720)
- **Problem:** `approvalCreatedBridge.test.ts:93–135` contains a local `listPending(db)` helper that duplicates `main/src/orchestrator/trpc/routers/approvals.ts:55–91` — same SELECT JOIN, same `DbApprovalRow` shape (renamed `DbRow` locally), same row-map projection, same inline 512-truncation (see A3/FIND-SPRINT-031-6). The bridge parity test asserts `bridge.workflowName === listPending.workflowName` — but if the production query adds an ORDER BY tiebreaker, a JOIN on a new table, or a new projected field, the test continues to pass against its stale clone while the production behavior diverges.
- **Proposed direction:** Extract the pure SELECT-and-shape projection from `approvalsRouter.listPending` into a standalone exported helper — e.g. `selectPendingApprovals(db: DatabaseLike): Approval[]` in a new `main/src/orchestrator/approvalListing.ts` module. The tRPC procedure becomes a thin wrapper: `selectPendingApprovals(db)`. Replace the local `listPending(db)` in `approvalCreatedBridge.test.ts` with a direct import of `selectPendingApprovals`. Delete the 40-line local clone. Verify with `pnpm --filter main test -- approvalCreatedBridge approvals`. This also resolves the truncation duplication (A3) if A3 is not addressed first, since `selectPendingApprovals` would use the shared helper.
- **Scope:** medium (new file, 1 tRPC procedure simplified, 1 test file refactored, `pnpm --filter main test` verification)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed near-verbatim clone — `trpc/routers/approvals.ts:64-90` (SELECT, `DbApprovalRow`, row.map projection) and `approvalCreatedBridge.test.ts:105-135` (identical SELECT, `DbRow` rename, identical projection) share the same shape including the inline 512-truncation; the parity test's whole purpose is bridge-vs-listPending agreement, so a stale local clone defeats its own guarantee. New file + thin router wrapper is the minimum extraction to make the parity assertion exercise the production code path.
- **Counterfactual:** If A3 lands and the clone's only remaining drift surface is the SELECT itself (already locked by the workflowName parity assertion), the marginal value of the new module drops and this could be deferred.

---

### B4. Add a typed StreamEnvelope builder to eliminate duplicate envelope-construction sites
- **Summary:** The typed `StreamEnvelope` is constructed manually at two separate sites (`runLauncher.ts` and `runEventBridge.ts`) — any new field added to `StreamEnvelope` must be remembered at both sites independently.
- **Source-Sprint:** SPRINT-031
- **Source:** FIND-SPRINT-031-9 (sprint-code-reviewer, suspected TASK-724 + TASK-725)
- **Problem:** TASK-724/725 invested in a discriminated-union `StreamEnvelopePayload` to make envelope shapes type-checked, but two manual construction sites exist:
  1. `runLauncher.ts:146–150` — synthetic `run_started` envelope with inline `type`/`payload`/`timestamp` wiring; no audited cast, outside the discriminator safety net.
  2. `runEventBridge.ts:240–244` — per-SDK-event envelope with `as StreamEnvelope` boundary cast.
  Any future addition to `StreamEnvelope` (e.g. a monotonic sequence number for renderer gap-detection) must be manually remembered at both sites. The SDK integration is still growing, and additional emit sites are likely.
- **Proposed direction:** Add `buildEnvelope<K extends StreamEventType>(type: K, payload: PayloadFor<K>): StreamEnvelope` in `shared/types/claudeStream.ts` (or a new `main/src/orchestrator/streamEnvelope.ts`). The function stamps `timestamp: new Date().toISOString()` and returns the fully-typed envelope. Use it from `runLauncher.ts:146` (eliminating the inline literal object) and `runEventBridge.ts:240` (the `as StreamEnvelope` boundary cast stays but is now isolated inside the builder). Add a unit test asserting the output shape (timestamp is ISO 8601, `type` is a valid `StreamEventType`, `payload` matches the variant). Verify with `pnpm typecheck` and `pnpm --filter main test -- runLauncher runEventBridge`.
- **Scope:** small (new utility function + 2 call sites + 1 unit test)

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Only two construction sites exist today (`runLauncher.ts:146` and `runEventBridge.ts:240`) and the latter is already the single audited boundary cast — adding a generic `buildEnvelope` builder with a `PayloadFor<K>` helper introduces a new typed indirection layer to solve a 2-site duplication that has not yet bitten, which is preemptive consolidation of the kind the proposal-engine warns against; the typed `StreamEnvelopePayload` discriminator already catches the cross-product type-checking concern and any future envelope-field addition (the cited "monotonic sequence number") would be caught by `tsc` at both call sites anyway.
- **Counterfactual:** A third or fourth envelope construction site landing in the SDK substrate, or a concrete field-addition incident where one site was forgotten, would flip this to IMPLEMENT.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Refresh CODE-PATTERNS.md "Database seed helpers" section — mark seedRun as landed and flag pending seedApproval
- **Summary:** The "Database seed helpers" section in `docs/CODE-PATTERNS.md` still frames `seedRun` as pending work even though TASK-722 landed `orchestratorTestDb.ts` this sprint, and it gives no guidance for `approvals` seeding (the drift surface FIND-SPRINT-031-7 just surfaced).
- **Source-Sprint:** SPRINT-031
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** replace existing "Database seed helpers (pending — see compounded FIND-SPRINT-018-12)" section (lines 130–137)
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  - ### Database seed helpers (pending — see compounded FIND-SPRINT-018-12)
  -
  - The `INSERT INTO workflow_runs (...)` literal currently appears 9+ times across `runExecutor.test.ts`, `runLauncher.test.ts`, `runLifecycle.test.ts`, and `cancelAndRestart.test.ts`. Do NOT add a 10th inline insert in new test files. Either:
  -
  - 1. Reuse the local `seedRun(db, runId, status)` helper at the top of `runLifecycle.test.ts` (will be hoisted into `__test_fixtures__/seed.ts` by a follow-up task), OR
  - 2. If you are writing a new test file before the shared fixture lands, copy the `seedRun` helper verbatim and add a TODO comment pointing at FIND-SPRINT-018-12 so the cleanup task can find it.
  -
  - A `workflow_runs` schema change (e.g. adding a NOT NULL column without a default) must currently touch every inline INSERT — keep the surface small until the shared `seedWorkflowRun` fixture lands.
  + ### Database seed helpers
  +
  + Shared helpers live in `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts`:
  +
  + - `createTestDb()` — in-memory `better-sqlite3` with the full cyboflow schema
  +   applied via `GATE_SCHEMA` (column-parity-tested against `006_cyboflow_schema.sql`).
  + - `seedRun(db, overrides?)` — inserts a `workflows` + `workflow_runs` pair;
  +   `overrides` accepts any column subset (e.g. `{ id, status, workflowName }`).
  +
  + Do NOT inline `INSERT INTO workflow_runs` in new test files — use `seedRun`.
  + Do NOT inline `INSERT INTO approvals` either — a `seedApproval` helper is pending
  + in the same fixture file (FIND-SPRINT-031-7); until it lands, prefer extending
  + `orchestratorTestDb.ts` over copying an inline INSERT.
  +
  + **Canonical examples:** `main/src/orchestrator/__tests__/approvalRouter.test.ts`,
  + `main/src/orchestrator/__tests__/runRecovery.test.ts`.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `docs/CODE-PATTERNS.md:130-137` still says "pending — see compounded FIND-SPRINT-018-12" while `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` exists with `createTestDb` + `seedRun(db, overrides?)` already used by three sibling tests — the doc is now actively misleading (telling agents to copy a helper that has been hoisted), and the refresh re-points future agents at the real fixture.

---

### C2. Document the StreamEvent derived-alias rule in CODE-PATTERNS.md
- **Summary:** Renderer `StreamEvent` in `frontend/src/utils/cyboflowApi.ts` must be expressed as `StreamEnvelope & { runId: string }`, not as a standalone re-declaration of all 9 `StreamEnvelopePayload` arms — a one-line rule that prevents the silent narrowing drift FIND-SPRINT-031-4 surfaced.
- **Source-Sprint:** SPRINT-031
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** insert-after "Canonical drift: FIND-SPRINT-026-20 — five surviving casts at `RunView.tsx:38,98,138,167,186`." (line 195)
- **Status:** ready
- **source_item:** C2
- **Diff:**
  ```diff
  + **StreamEvent must be a derived alias, not a re-declaration.** Express the
  + renderer type as `StreamEvent = StreamEnvelope & { runId: string }` in
  + `frontend/src/utils/cyboflowApi.ts` — never re-declare the `StreamEnvelopePayload`
  + arms locally. A parallel union forces synchronized edits across `StreamEventType`,
  + `StreamEnvelopePayload`, and the renderer type; omission silently routes new
  + variants to `UnknownEventRow` instead of failing typecheck.
  + Canonical drift: FIND-SPRINT-031-4 — resolved as A4 in the SPRINT-031 compound.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The existing `StreamEvent discriminated-union narrowing` block at `docs/CODE-PATTERNS.md:187-195` covers the `payload: unknown` anti-pattern but is silent on the derived-alias-vs-re-declaration choice that A4 enshrines; with A4 collapsing 9 arms to `StreamEnvelope & { runId: string }`, the rule prevents a future agent from re-introducing parallel arms when adding a new SDK variant — a concrete failure mode (silent fall-through to `UnknownEventRow`) FIND-SPRINT-031-4 already identified.
- **Counterfactual:** If A4 is rejected, this rule has nothing to reinforce and should be dropped.

No stale-open findings were detected. All 9 SPRINT-031 findings (`FIND-SPRINT-031-1` through `FIND-SPRINT-031-9`) have `status: open` and none of the 9 done reports contain a `**Findings resolved:**` line referencing any of these IDs. All findings were triaged above.
