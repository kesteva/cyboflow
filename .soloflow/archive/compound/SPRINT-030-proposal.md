---
sprints: [SPRINT-030]
span_label: SPRINT-030
created: 2026-05-22T02:00:00.000Z
counters_start:
  ideas: 21
summary:
  cleanups: 4
  backlog_tasks: 4
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-030

## A. Clean-up items (execute now)

### A1. Fix same-millisecond flake in day-3 gate timing assertion
- **Summary:** Change `toBeGreaterThan` to `toBeGreaterThanOrEqual` at `cyboflowDayGate.test.ts:124` to eliminate a pre-existing intermittent failure where two sequential `Date.now()` calls land in the same millisecond.
- **Source-Sprint:** SPRINT-030
- **Rationale:** The flake was observed during SPRINT-030 verification: first run failed (both timestamps `1779409716748 == 1779409716748`), second run passed. The timing check is structurally redundant because the sequential `await` ordering already guarantees chronological ordering; a `>=` comparison preserves the semantic intent without the flake. Fixes the `pnpm test:gate` reliability regression noted in `human-review-queue.md` (dedup_key: `sprint030_day3_gate_same_millisecond_flake`).
- **Blast radius:** 1 file, 1 line — `main/src/orchestrator/__tests__/cyboflowDayGate.test.ts:124`. Trivial risk.
- **Source:** FIND-SPRINT-030-3 (TASK-701 verifier); `human-review-queue.md` action item `sprint030_day3_gate_same_millisecond_flake`.
- **Proposed change:**
  ```diff
  // main/src/orchestrator/__tests__/cyboflowDayGate.test.ts:124
  - expect(t2).toBeGreaterThan(t1);
  + expect(t2).toBeGreaterThanOrEqual(t1);
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed at `cyboflowDayGate.test.ts:124` — `expect(t2).toBeGreaterThan(t1)` follows two sequential `Date.now()` reads that can collide on a fast Mac; the prior `await` chain already guarantees ordering, so the `>=` swap eliminates a real intermittent failure (FIND-SPRINT-030-3) at one-line cost.

---

### A2. Standardize the cast at `cyboflow-stream-publisher.test.ts:115` to annotation form
- **Summary:** Replace the inline `run_started as StreamEventType` cast at line 115 of `cyboflow-stream-publisher.test.ts` with the same explicit `const`-with-annotation idiom used at lines 67, 86, and 100 so all four test event literals are uniform.
- **Source-Sprint:** SPRINT-030
- **Rationale:** Three of the four call sites in the same file use `const x: { type: StreamEventType; payload: unknown; timestamp: string } = {...}`; line 115 alone uses `{ type: 'run_started' as StreamEventType, ... }`. The cast form bypasses TypeScript structural checking on that literal — if a future field is added to the publisher event shape, line 115 will silently pass while the other three would catch the regression. TASK-700 introduced this inconsistency as a quick fix for the typecheck regression during its second executor loop.
- **Blast radius:** 1 file, ~3 lines — `main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts:115`. Trivial risk.
- **Source:** FIND-SPRINT-030-10 (sprint-code-reviewer); TASK-700 done report (executor_loops=1, round-2 typecheck fix).
- **Proposed change:**
  ```diff
  // main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts:115
  // Before (cast form):
  -   publisher.publish({ type: 'run_started' as StreamEventType, payload: {}, timestamp: '' });
  // After (annotation form, matching lines 67/86/100):
  +   const invalidEvent: { type: StreamEventType; payload: unknown; timestamp: string } = {
  +     type: 'run_started',
  +     payload: {},
  +     timestamp: '',
  +   };
  +   publisher.publish(invalidEvent);
  ```
  Note: if B2 lands first and exports a named `StreamEnvelope`, use `const invalidEvent: StreamEnvelope` instead and skip the inline structural type.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at `cyboflow-stream-publisher.test.ts:67/86/100` (annotation form) vs `:115` (inline `'run_started' as StreamEventType` cast) — the cast form bypasses structural checking on the literal, so future shape changes silently pass only at this site; the fix is 3 lines in one test file.

---

### A3. Delete redundant test (g) from `DraggableProjectTreeView.runs.test.tsx`
- **Summary:** Remove test (g) `clicking a run row sets activeProjectId with the runs project_id` from `DraggableProjectTreeView.runs.test.tsx` because its assertions are a strict subset of the already-updated test (e), making it impossible for (g) to fail without (e) also failing.
- **Source-Sprint:** SPRINT-030
- **Rationale:** TASK-703 added test (g) alongside updating test (e) with the same `mockSetActiveProjectId.toHaveBeenCalledWith(1)` and `mockNavigateToSessions.not.toHaveBeenCalled()` assertions. Test (g) uses different fixture data (different run id, different workflow code) but exercises the same code path with the same expected mock outcomes. It adds no coverage value and can only fail if test (e) also fails. If parametric coverage of multiple `project_id` values is desired, `it.each` is the right tool (noted in the finding's suggestion).
- **Blast radius:** 1 file, ~20 lines deleted — `frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx:377-396`. Low risk.
- **Source:** FIND-SPRINT-030-11 (sprint-code-reviewer); TASK-703 done report.
- **Proposed change:**
  Delete the block from `DraggableProjectTreeView.runs.test.tsx` spanning lines 377-396 (test (g): `clicking a run row sets activeProjectId with the runs project_id`). Test (e) at lines 354-375 already covers the same behavioral contract.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified at `DraggableProjectTreeView.runs.test.tsx:354-375` (test (e)) and `:377-396` (test (g)) — both assert `mockSetActiveProjectId.toHaveBeenCalledWith(1)` and `mockNavigateToSessions.not.toHaveBeenCalled()` against the same code path with only fixture-label changes (`CLICK6` vs `PRJID6`, same `project_id: 1`), so (g) cannot fail unless (e) also fails.

---

### A4. Fix misleading payload fixtures in `cyboflowStore.test.ts` unknown-arm tests
- **Summary:** Update tests 5 and 7 in `cyboflowStore.test.ts` so the `payload` shapes on `type: 'unknown'` envelope literals reflect what the `unknown` arm actually means at runtime instead of carrying a well-formed `system` payload or a source-only partial.
- **Source-Sprint:** SPRINT-030
- **Rationale:** TASK-700 fixed a typecheck regression by changing the envelope `type` from `'system'` to `'unknown'` in two test fixtures, but left the inner `payload` shapes unchanged. Test 5 now has `type: 'unknown'` with `payload: { type: 'system' }` — a well-formed system event arriving on the unknown arm, which cannot happen in production. Test 7 has `type: 'unknown'` with `payload: { source: 'run-B' }` — no `type` field. Neither fixture reflects the actual runtime semantics of the `unknown` envelope (a wire event that `deriveEventType` failed to classify). The tests still verify what they intend (subscription teardown, callback routing) but the fixtures will mislead future contributors.
- **Blast radius:** 1 file, 2 fixture literals — `frontend/src/stores/__tests__/cyboflowStore.test.ts:128-133, 180-185`. Low risk.
- **Source:** FIND-SPRINT-030-12 (sprint-code-reviewer); TASK-700 done report.
- **Proposed change:**
  Option (a): replace both payload values with shapes that are genuinely unclassifiable by `deriveEventType`, e.g. `payload: { unrecognized_field: 'xyz' }`. This accurately represents what the `unknown` arm means and makes the fixture self-documenting.
  Option (b): restore `type: 'system'` envelopes with a valid `SystemInitEvent` payload that satisfies the tightened union. This is more faithful to the original test intent (these tests are not about unknown events) but requires constructing a valid literal.
  Either option removes the misleading mismatch. Option (a) is lower-effort.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed at `cyboflowStore.test.ts:128-133` (`type: 'unknown'` with `payload: { type: 'system' }`) and `:180-185` (`payload: { source: 'run-B' }`) — the fixtures will mislead future contributors about what the `unknown` arm means at runtime; option (a) is a 2-literal change in one test file with no behavioral impact.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Fix `verify-schema-parity.js` failure on legacy `projects`-table migrations
- **Summary:** `pnpm test:unit` exits non-zero at the `verify:schema` step because `scripts/verify-schema-parity.js` fails with `SqliteError: no such column: permission_mode` when replaying historical migrations — the `projects` table that migration 008 targets is absent from `schema.sql`.
- **Source-Sprint:** SPRINT-030
- **Source:** FIND-SPRINT-030-4 (TASK-702 verifier); `human-review-queue.md` action item `sprint030_verify_schema_parity_permission_mode`.
- **Problem:** `scripts/verify-schema-parity.js:82` replays all migrations in order. Path-1 (schema.sql + migrations applied sequentially) fails at migration `008_permission_mode_approve_default.sql:6` which does `UPDATE projects SET default_permission_mode = 'approve'`. The `projects` table does not exist in `main/src/database/schema.sql` (only `sessions`, `session_outputs`, `conversation_messages`, `workflows`, `workflow_runs` are present); the migration that would create it appears to be in `migrations/legacy/` or missing. The script tolerates `no such table` errors but SQLite returns `no such column` first (because the table was created without that column by an earlier migration step that IS present). This failure pre-dates SPRINT-030; no schema or script files were touched this sprint (verified via `git log c8f07cf..HEAD -- scripts/verify-schema-parity.js main/src/database/`). The failure wedges `pnpm test:unit` chain regardless of whether main or frontend vitest pass.
- **Proposed direction:** Audit `main/src/database/migrations/` to identify which migration creates the `projects` table and why it is absent or quarantined. Three resolution paths: (a) widen the `verify-schema-parity.js` tolerated-error set from `no such table` to also include `no such column`, documented with a comment explaining the legacy `projects` migration gap; (b) add a `projects` table DDL to `schema.sql` (or restore the missing migration from `migrations/legacy/`) so the schema is self-consistent; (c) add a skip-list so migrations referencing the legacy `projects` table are bypassed in path-1 replay. Option (b) is the most correct — it fixes the underlying schema drift the script was built to detect. Option (a) is the quickest unblock. Either way, confirm `node scripts/__tests__/verify-schema-parity.test.js` and `pnpm test:unit` exit 0 after the fix.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed live failure: `scripts/verify-schema-parity.js:70-84` tolerates only `no such table` errors, but migration `008_permission_mode_approve_default.sql:6` runs `UPDATE projects SET default_permission_mode = 'approve'` while `schema.sql` declares no `projects` table (the `add_project_support.sql` migration lives in `migrations/legacy/`), so `pnpm test:unit` exits non-zero — TASK-722 explicitly excludes this script ("scripts/verify-schema-parity.js" in `files_readonly`, line 16; rejected alternative line 103) so it does not duplicate in-flight work.

---

### B2. Export `StreamEnvelope` from shared types and consolidate 4+ structural duplicates
- **Summary:** Promote the `StreamEnvelope` interface already declared (but unexported) in `main/src/orchestrator/runEventBridge.ts:119` to `shared/types/claudeStream.ts` and replace the four inline structural duplications of `{ type: StreamEventType; payload: unknown; timestamp: string }` with a single named reference.
- **Source-Sprint:** SPRINT-030
- **Source:** FIND-SPRINT-030-7 (sprint-code-reviewer); TASK-700 done report.
- **Problem:** The literal `{ type: StreamEventType; payload: unknown; timestamp: string }` appears in four newly-introduced locations: the `StreamEventPublisher.publish` parameter at `main/src/orchestrator/runLauncher.ts:66`, and three explicit `const x: {...}` annotations at `main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts:67, 86, 100`. An identical interface already exists at `runEventBridge.ts:119` but is unexported. As more IPC channels and tests are added (epic 7 wires the full approval flow per `cyboflow.ts:209`), additional duplications will accumulate. A5 (the cast at line 115) is a fifth site.
- **Proposed direction:** Export `StreamEnvelope` from `shared/types/claudeStream.ts` (or from `main/src/orchestrator/runEventBridge.ts` with a re-export from shared). Update `StreamEventPublisher.publish`'s parameter type, the three `const`-annotation sites in `cyboflow-stream-publisher.test.ts`, and the unexported local in `runEventBridge.ts` to all reference the single exported name. After landing, A2's fix becomes `const invalidEvent: StreamEnvelope`. Also assess whether the `payload: unknown` field should remain `unknown` or be tightened to a discriminated union as part of this consolidation (FIND-SPRINT-030-8 is the companion issue on the payload type contract).
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified four duplicated declarations of `{ type: StreamEventType; payload: unknown; timestamp: string }` at `runLauncher.ts:65-67` and `cyboflow-stream-publisher.test.ts:67/86/100`, plus an unexported `StreamEnvelope` already at `runEventBridge.ts:119` ready to promote — the consolidation is a code-move not a new abstraction, and epic 7 (per `cyboflow.ts:209` comment chain) will keep adding stream-event sites.

---

### B3. Resolve `RunStartedEvent` payload type contract mismatch at the producer
- **Summary:** The producer in `runLauncher.ts:146-150` emits a `run_started` envelope with an inner `payload` that omits the `type: 'run_started'` field declared in the `RunStartedEvent` interface, violating the type contract silently because `StreamEventPublisher.publish` takes `payload: unknown`.
- **Source-Sprint:** SPRINT-030
- **Source:** FIND-SPRINT-030-8 (sprint-code-reviewer). Suspected tasks: TASK-696, TASK-700.
- **Problem:** `shared/types/claudeStream.ts:264-269` declares `RunStartedEvent` as `{ type: 'run_started'; runId; worktreePath; branchName }`. The renderer-facing discriminated union pins the `run_started` arm to `payload: RunStartedEvent`. But `runLauncher.ts:146-150` emits `{ type: 'run_started', payload: { runId, worktreePath, branchName }, timestamp }` — the inner `payload` object lacks the required `type: 'run_started'` field. The UI currently works because `RunStartedEventRow` only reads `payload.runId` and `payload.branchName`, but the contract is violated and TypeScript cannot catch it because the publisher accepts `payload: unknown`. This is the class of cross-task drift that per-task code review cannot catch (TASK-696 owned the declared shape, TASK-700 owned the publisher and renderer arm).
- **Proposed direction:** Pick one of two mutually exclusive fixes: (a) make the producer match the declared contract — add `type: 'run_started'` to the payload literal in `runLauncher.ts:146-150`; or (b) drop the redundant `type` field from the `RunStartedEvent` declaration in `shared/types/claudeStream.ts` since the envelope's outer `type` already discriminates. After picking (a) or (b), tighten `StreamEventPublisher.publish`'s `payload` from `unknown` to the full discriminated `StreamEvent` payload union so TypeScript catches future drift at the publish site. Coordinate with B2 (StreamEnvelope consolidation) since tightening `payload` directly affects the interface shape.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified producer/declaration drift: `runLauncher.ts:146-150` emits `payload: { runId, worktreePath, branchName }` while `shared/types/claudeStream.ts:265-270` declares `RunStartedEvent` with a required `type: 'run_started'` field, and `StreamEventPublisher.publish`'s `payload: unknown` signature (runLauncher.ts:66) hides the mismatch from TS — this is exactly the cross-task type-drift class CLAUDE.md's "IPC handler ↔ declared T parity" rule warns about, just on the publisher side.

---

### B4. Replace hand-rolled IPC validators with a Zod-based shared helper
- **Summary:** Replace the `validateNumberArg` and `validateStringArg` helpers introduced in `main/src/ipc/cyboflow.ts` by TASK-705 with a reusable Zod-based helper that aligns with the existing validation pattern in `main/src/orchestrator/trpc/routers/*.ts` and eases the forthcoming tRPC ipcLink migration.
- **Source-Sprint:** SPRINT-030
- **Source:** FIND-SPRINT-030-9 (sprint-code-reviewer); TASK-705 done report.
- **Problem:** TASK-705 introduced two local helpers (`validateNumberArg`, `validateStringArg`) in `main/src/ipc/cyboflow.ts:60-83` that duplicate functionality already provided by Zod (`z.number().finite()`, `z.string().min(1)`). The project already uses Zod for runtime validation in `main/src/orchestrator/trpc/routers/*.ts` (e.g. `runs.ts:147` `.input(z.object({ projectId: z.string() }))`) and in `main/src/services/streamParser/schemas.ts`. The project is mid-migration to a tRPC ipcLink architecture (per `cyboflow.ts:221`) where input validation is already Zod-based; adding more hand-rolled validators now makes the eventual tRPC cutover a re-validate rather than a code-move. The `docs/CODE-PATTERNS.md:213-226` IPC validation section also now references `main/src/ipc/cyboflow.ts` as the canonical example but the example uses hand-rolled guards, not Zod.
- **Proposed direction:** Introduce a small shared helper, e.g. `function validateInput<T>(schema: ZodType<T>, args: unknown, channel: string): { ok: true; value: T } | { ok: false; error: string }` in `main/src/ipc/cyboflow.ts` (or a shared `main/src/ipc/validateInput.ts`). Replace `validateNumberArg`/`validateStringArg` call sites with e.g. `validateInput(z.object({ projectId: z.number().finite() }), args, 'cyboflow:listRuns')`. The `{ success: false, error }` IPC envelope contract is preserved (the helper returns `{ ok: false }` which the handler maps to `{ success: false, error }`). Existing tests in `main/src/ipc/__tests__/cyboflow.test.ts` should continue to pass against the same error messages. After landing, update `docs/CODE-PATTERNS.md` to cite `validateInput` as the canonical pattern for IPC arg validation. Note: NaN and ±Infinity rejection (currently in `validateNumberArg` via `!Number.isFinite`) translates to `z.number().finite()`.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified parallel-validator drift: `main/src/ipc/cyboflow.ts:62-83` defines hand-rolled `validateNumberArg`/`validateStringArg` used at 3 call sites (`:104`, `:141`, `:143`, `:183`), while tRPC routers already use `z.object(...)` (e.g. `runs.ts:141/147/153/171/198/237`, `approvals.ts:105`) — the divergence will compound as epic 7 wires more IPC handlers and the planned ipcLink migration (`cyboflow.ts:221`) is already Zod-shaped.
- **Counterfactual:** If the tRPC ipcLink migration is imminent enough that these 3 handlers will move under tRPC within the next 1-2 sprints anyway, this becomes wasted churn — defer until that migration's scope is clearer.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Update CODE-PATTERNS.md IPC validation section — stale forward-reference resolved
- **Summary:** Remove the stale "after B3 lands" forward-reference in `docs/CODE-PATTERNS.md` now that TASK-705 has landed the `validateNumberArg`/`validateStringArg` helpers, and note the pending Zod-based upgrade.
- **Source-Sprint:** SPRINT-030
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** replace lines 228-231 (the paragraph following the `cyboflow:listRuns` code block)
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  --- a/docs/CODE-PATTERNS.md
  +++ b/docs/CODE-PATTERNS.md
  @@ -225,8 +225,9 @@ ipcMain.handle('cyboflow:listRuns', (_event, args: unknown) => {
   });
   ```
  -For domains with multiple handlers sharing the same arg shapes, extract a `validateArg`
  -helper in the domain's IPC file (see `main/src/ipc/cyboflow.ts` after B3 lands). This
  -keeps the guard co-located with the handler and easy to audit during handler additions.
  -Canonical drift: FIND-SPRINT-028-11 — three cyboflow:* handlers without guards.
  +For domains with multiple handlers sharing the same arg shapes, extract a `validateArg`
  +helper in the domain's IPC file (canonical example: `validateNumberArg` / `validateStringArg`
  +in `main/src/ipc/cyboflow.ts`, landed in TASK-705). Hand-rolled today; a Zod-based
  +`validateInput<T>(schema, args, channel)` upgrade is tracked under FIND-SPRINT-030-9 to
  +align with the tRPC router pattern and ease the forthcoming ipcLink migration.
  +Canonical drift: FIND-SPRINT-028-11 — three cyboflow:* handlers without guards.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed stale forward-reference at `docs/CODE-PATTERNS.md:229` ("see `main/src/ipc/cyboflow.ts` after B3 lands") even though TASK-705 already landed `validateNumberArg`/`validateStringArg` in `main/src/ipc/cyboflow.ts:62-83` — the doc directs future readers to a "pending" example that is actually present, which is exactly the rule-drift the proposal corrects.

---

## Reconciled Findings (informational)

The following finding had `status: open` in the findings file at sprint-close time but is claimed as resolved by a done report. The sprint-closer's reconciliation step did not patch the status. No triage action was taken for these items.

- `FIND-SPRINT-030-2` — claimed resolved by TASK-700 in `/Users/raimundoesteva/Developer/cyboflow/.soloflow/archive/done/claude-agent-sdk-migration/TASK-700-done.md` (line: "Resolved: FIND-SPRINT-030-2"; also confirmed by the done report's text: "The TASK-696-era local `ExtendedStreamEventType` alias is also deleted (resolves FIND-SPRINT-030-2)"). The findings file shows `resolved_by: TASK-700` but `status:` remains `open` rather than `resolved`. Sprint-closer reconciliation pending.

---

## Suppressed — SoloFlow Defects

The following candidate was considered for Bucket C but reclassified as a SoloFlow plugin behavioral issue. Because `tester: false`, it is suppressed here rather than promoted to Bucket D.

- **Planner skill does not detect readonly ↔ AC9 typecheck conflicts** (FIND-SPRINT-030-5) — the finding's suggested fix targets "the planner skill" and "planning checklist in CLAUDE.md / planner docs" specifically because TASK-700's plan listed `main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts` in `files_readonly` while AC9 required editing it to satisfy the tightened publisher signature. The rule would be: "when a shared-interface signature is in `files_owned`, scan for dependent `__tests__/*publisher*.test.ts` files and include them in `files_owned` or add an explicit typecheck-fallout carve-out." This rule is about how SoloFlow plans are structured, not about a cyboflow codebase convention — it would evaporate if the project stopped using SoloFlow. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.
