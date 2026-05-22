---
sprint: SPRINT-030
pending_count: 9
last_updated: "2026-05-22T01:35:36.464Z"
---
# Findings Queue

## FIND-SPRINT-030-1
- **type:** bug
- **source:** TASK-698 (executor)
- **severity:** medium
- **status:** resolved
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
- **description:** The killProcess test times out at 5000ms on both main and TASK-698 worktree. Pre-existing flaky test unrelated to TASK-698.
- **suggested_action:** Investigate mock/async setup - likely a promise or observable that never resolves. Fix the underlying mock or increase timeout.
- **resolved_by:** verifier — status-sync: TASK-697 (commit f0063a7 removed the pre-kill await on spawnPromise, eliminating the deadlock; killProcess test now passes in ~7ms across 3 consecutive full-suite runs)

## FIND-SPRINT-030-2
- **type:** improvement
- **source:** TASK-696 (code-reviewer)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/utils/cyboflowApi.ts:52-58 (StreamEventType union); frontend/src/components/cyboflow/RunView.tsx:39-45 (local widening)
- **description:** TASK-696 added `session_info` and `rate_limit_event` to the renderer's `switch (event.type)` dispatcher. Because `cyboflowApi.ts` is marked `files_readonly` for the task, the renderer falls back to a local `ExtendedStreamEventType` alias and an inline `event.type as ExtendedStreamEventType` cast at the switch site. The inline `// TODO(IDEA-021 follow-up): widen StreamEventType in cyboflowApi.ts in a sibling task` comment captures the intent but the widening still needs a backlog task to land. Until then, any future RunView contributor adding another typed branch will have to extend the local alias (or perpetuate the cast) instead of relying on the canonical `StreamEventType` union — which is exactly the drift surface this comment warns about.
- **suggested_action:** Open a follow-up task to widen `StreamEventType` in `frontend/src/utils/cyboflowApi.ts` to include `'session_info' | 'rate_limit_event'` (and audit `main/src/services/streamParser/derivers.ts:deriveEventType` to confirm both strings are actually emitted on the envelope `type` field). On landing, remove the `ExtendedStreamEventType` alias + cast in `RunView.tsx` and the two `as StreamEvent['type']` casts in `RunView.test.tsx:396, :424`.
- **resolved_by:** TASK-700

## FIND-SPRINT-030-3
- **type:** bug
- **source:** TASK-701 (verifier)
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/cyboflowDayGate.test.ts:124
- **description:** The day-3 gate test contains a pre-existing flaky timing assertion: expect(t2).toBeGreaterThan(t1) where t1 = Date.now() before approveRun(prune) and t2 = Date.now() after approveRun(sprint). Both calls land within the same millisecond on a fast Mac (approveRun resolves synchronously enough that the two Date.now() calls return the same value). Observed during TASK-701 verification: first pnpm test:gate run failed (1779409716748 == 1779409716748), second run passed. The relocation in TASK-701 preserved the original logic verbatim — this flake pre-dated TASK-701 (logic unchanged from the original tests/cyboflow-day3-gate.spec.ts at TASK-355 / TASK-605). AC#6 (pnpm test:gate exits 0) only passes intermittently when claude is in PATH, which weakens this test as a sprint-completion gate.
- **suggested_action:** Replace expect(t2).toBeGreaterThan(t1) with expect(t2).toBeGreaterThanOrEqual(t1). The genuine assertion the test is trying to make is captured elsewhere (the explicit ordering of awaits and the awaiting_review mid-check). The chronological-ordering check is structurally guaranteed by the sequential awaits, so a >= comparison preserves the spirit while eliminating the same-millisecond flake.

## FIND-SPRINT-030-4
- **source:** TASK-702 (verifier)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** scripts/verify-schema-parity.js:82 (failure surface); main/src/database/schema.sql (root cause — no `projects` table); main/src/database/migrations/008_permission_mode_approve_default.sql:6 (failing UPDATE against missing table)
- **description:** `pnpm test:unit` fails at the `verify:schema` chain step with `SqliteError: no such column: permission_mode` when migration 008 runs `UPDATE projects SET default_permission_mode = 'approve'`. Root cause: `main/src/database/schema.sql` does NOT declare a `projects` table (only sessions, session_outputs, conversation_messages, workflows, workflow_runs), so path-1 of the parity check (schema.sql + migrations applied in order) errors when migration 008 references it. The script's existing fallback only tolerates `no such table` errors, not `no such column` — SQLite reports the column error first because the prior migration that creates `projects` is missing or quarantined into `migrations/legacy/`. Pre-existing on main (no schema or script edits during SPRINT-030; verified `git diff a1afbf7..HEAD -- main/src/database/`). TASK-702's plan AC#5 carved out only `cyboflowSchema.test.ts` (which now passes 13/13); this is a different and previously-unflagged failure surface.
- **suggested_action:** Either (a) widen `verify-schema-parity.js`'s tolerated-error pattern from `no such table` to also include `no such column` so legacy `projects`-table migrations don't break path-1, OR (b) add a `projects` table declaration to `schema.sql` (or restore it from `migrations/legacy/`) so the schema is actually self-consistent — this is the underlying drift the script was built to catch (FIND-SPRINT-015-21 class).
- **resolved_by:** 

## FIND-SPRINT-030-5
- **source:** TASK-700 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** .soloflow/active/plans/claude-agent-sdk-migration/TASK-700-plan.md (files_readonly), main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts:66-70
- **description:** TASK-700's plan listed `main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts` in `files_readonly`, but the plan's own AC9 (`pnpm typecheck exits 0 end-to-end`) is incompatible with that classification once `StreamEventPublisher.publish` is tightened from `event.type: string` to `event.type: StreamEventType`. The test declares `const event = { type: 'run_started', ... }` with no type annotation, so TS infers `type: string` which is no longer assignable to the tightened parameter. The plan-author placed a file in readonly that the AC mandates editing — the planner skill should detect this class of conflict (broad-AC + readonly downstream consumer) and either (a) move such files to `files_owned`, or (b) explicitly carve out their typecheck as a deferred follow-up the way TASK-700's AC8 already does for FIND-SPRINT-026-10. The verifier flagged the regression because the executor accepted the readonly constraint and shipped a failing typecheck while reporting "typecheck 0".
- **suggested_action:** Update the planner skill (or the planning checklist in CLAUDE.md / planner docs) to flag readonly-listed test files whose typecheck depends on the signature being tightened in `files_owned`. Concretely: when an `IPC*Publisher` / shared-interface signature is in `files_owned`, scan for `__tests__/*publisher*.test.ts` (and other contract tests) and either include them in `files_owned` or add an explicit "expected typecheck fallout" carve-out to the AC. Companion fix on TASK-700 itself: either (i) widen `files_owned` to include `cyboflow-stream-publisher.test.ts` and annotate the literal with `satisfies { type: StreamEventType; ... }` / `as const`, or (ii) loosen the publisher signature to keep `type: string` and tighten only at runtime via deriveEventType, as runEventBridge already does at envelope construction time.
- **resolved_by:** 

## FIND-SPRINT-030-6
- **type:** scope_deviation
- **source:** TASK-700 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/stores/__tests__/cyboflowStore.test.ts
- **description:** required to meet AC9 (pnpm typecheck exits 0): discriminated StreamEvent union tightened by round-0 work made stub payloads {} and { type: system } incompatible with the payload type constraints. File was files_readonly; claimed to fix typecheck failures.
- **resolved_by:** verifier — files_owned: cyboflowStore.test.ts is plan line 13 in files_owned (not files_readonly) — no deviation here. The actual readonly-file edit (main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts in round 2) is AC-prescribed by AC9 (pnpm typecheck exits 0) per the publisher-signature tightening, and is the subject of FIND-SPRINT-030-5 which already documents the planner conflict.

## FIND-SPRINT-030-7
- **source:** SPRINT-030 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runLauncher.ts:66; main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts:67,86,100
- **description:** Inline structural type duplication across the new StreamEventType plumbing. The literal `{ type: StreamEventType; payload: unknown; timestamp: string }` is repeated in four places introduced this sprint: the `StreamEventPublisher.publish` parameter type at runLauncher.ts:66, and three local declarations at cyboflow-stream-publisher.test.ts:67, :86, :100. The test-side duplication was forced by TASK-700 needing to upgrade test literals to satisfy the tightened publisher signature (FIND-SPRINT-030-5 covers the planner/readonly aspect; this is the residual structural-typedef redundancy).
- **suggested_action:** Export a single named interface (e.g., `StreamEnvelope` in shared/types/claudeStream.ts or co-located with StreamEventPublisher) covering `{ type: StreamEventType; payload: unknown; timestamp: string }` and have both `StreamEventPublisher.publish` and the three test sites reference it. Note that `runEventBridge.ts:119` already declares an interface named `StreamEnvelope` with the same shape — promote that to the shared types module (or re-export it) instead of defining a fifth copy.
- **resolved_by:** 






Suspected tasks: TASK-700

## FIND-SPRINT-030-8
- **source:** SPRINT-030 (sprint-code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/runLauncher.ts:146-150 (emission); shared/types/claudeStream.ts:264-269 (declared shape); frontend/src/utils/cyboflowApi.ts:99 (renderer-side payload type)
- **description:** `RunStartedEvent` is declared in shared/types/claudeStream.ts as `{ type: run_started; runId; worktreePath; branchName }`, and the renderer-facing discriminated union pins the `run_started` arm to `payload: RunStartedEvent`. However, the producer in runLauncher.ts:146-150 emits `{ type: run_started, payload: { runId, worktreePath, branchName }, timestamp }` — the inner `payload` omits the required `type: run_started` field. The frontend `RunStartedEventRow` only reads `payload.runId` and `payload.branchName` so the UI still works, but the type contract is violated. The mismatch is invisible to TypeScript because `StreamEventPublisher.publish` declares `payload: unknown` (runLauncher.ts:66) — TASK-700 tightened the `type` field but left `payload` as `unknown`. This is the exact class of drift the per-task code-reviewer cannot catch, since TASK-696 owned `RunStartedEvent`s declared shape and TASK-700 owned the publisher signature and renderer arm.
- **suggested_action:** Either (a) Make the producer match the declared contract: change runLauncher.ts:146-150 to emit `payload: { type: run_started, runId, worktreePath, branchName }`. OR (b) Drop the redundant `type` field from `RunStartedEvent` since the envelope `type` already discriminates and the inner `type` is never read. Pick one and apply consistently. Then tighten `StreamEventPublisher.publish` from `payload: unknown` to a discriminated parameter (e.g., accept the same StreamEnvelope union the renderer consumes) so TypeScript catches future drift at the publish site.
- **resolved_by:** 





Suspected tasks: TASK-696, TASK-700

## FIND-SPRINT-030-9
- **source:** SPRINT-030 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/ipc/cyboflow.ts:60-83 (new helpers); main/src/orchestrator/trpc/routers/runs.ts:141,147,153 (existing zod pattern); main/src/services/streamParser/schemas.ts (existing zod pattern)
- **description:** TASK-705 introduced hand-rolled validators `validateNumberArg` and `validateStringArg` in `main/src/ipc/cyboflow.ts` (lines 60-83) and applied them to three IPC handlers. The project already uses Zod for runtime validation in `main/src/orchestrator/trpc/routers/*.ts` (e.g. `.input(z.object({ projectId: z.string() }))` at runs.ts:147) and in `main/src/services/streamParser/schemas.ts`. The new validators duplicate functionality Zod already provides (`z.number().finite()`, `z.string().min(1)`) and introduce a parallel error-shape pattern. Because IPC handlers will continue to expand (epic 7 wires real approval flow per cyboflow.ts:209), this divergence will compound. Note that the project is mid-migration toward tRPC ipcLink (per cyboflow.ts:221) where input validation is already Zod-based — adding more hand-rolled validators now makes the eventual tRPC cutover harder.
- **suggested_action:** Replace `validateNumberArg`/`validateStringArg` with a tiny shared Zod helper such as `function validateInput<T>(schema: ZodType<T>, args: unknown, channel: string): { ok: true; value: T } | { ok: false; error: string }`, used as e.g. `validateInput(z.object({ projectId: z.number().finite() }), args, cyboflow:listRuns)`. This (a) reuses the projects canonical validation library, (b) preserves the `{ success: false, error }` IPC envelope contract, (c) aligns with the tRPC router pattern so the upcoming ipcLink migration is mostly a code-move rather than a re-validate. The existing tests in `__tests__/cyboflow.test.ts` should continue to pass against the same error messages.
- **resolved_by:** 




Suspected tasks: TASK-705

## FIND-SPRINT-030-10
- **source:** SPRINT-030 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts:67,86,100 (explicit annotation); main/src/ipc/__tests__/cyboflow-stream-publisher.test.ts:115 (inline cast)
- **description:** Within the same file (`cyboflow-stream-publisher.test.ts`), TASK-700 fixed the typecheck regression in four call sites using two different idioms. Three sites declare a local `const x: { type: StreamEventType; payload: unknown; timestamp: string } = {...}` (lines 67, 86, 100), while the fourth site at line 115 uses an inline `{ type: run_started as StreamEventType, payload: {}, timestamp:  }` cast. The cast form bypasses TS structural checking on the literal at that site — if a future field is added to the publisher event shape, line 115 will silently pass while the other three would catch the regression.
- **suggested_action:** Pick one pattern and apply it consistently. Preferred: extract the inline structural type into a single named alias (see FIND-SPRINT-030-7) so all four sites become `const x: StreamEnvelope = {...}` with no casts. If the cast form is retained for terseness, at minimum convert line 115 to the same `const`-with-annotation idiom so the four tests are uniform.
- **resolved_by:** 



Suspected tasks: TASK-700

## FIND-SPRINT-030-11
- **source:** SPRINT-030 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx:354-375 (test (e)); :377-396 (test (g))
- **description:** TASK-703 added test (g) `clicking a run row sets activeProjectId with the runs project_id`, but its assertions are a strict subset of the assertions in test (e) `clicking a run row triggers setActiveRun and setActiveProjectId, not navigateToSessions` (which was updated in the same task to include the same `mockSetActiveProjectId.toHaveBeenCalledWith(1)` and `mockNavigateToSessions.not.toHaveBeenCalled()` checks). Test (g) has different fixture data (run id, workflow code) but verifies the same code path with the same expected mock arguments. Net effect: test (g) is redundant — it cannot fail unless test (e) also fails.
- **suggested_action:** Delete test (g). If the intent was to vary `project_id` to confirm propagation across multiple values, refactor the assertion using `it.each([[1, wf-a], [42, wf-b]])(...)` to parametrize over project_id so test (e) covers both single-row click semantics and value-propagation in one place.
- **resolved_by:** 


Suspected tasks: TASK-703

## FIND-SPRINT-030-12
- **source:** SPRINT-030 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/stores/__tests__/cyboflowStore.test.ts:128-133 (test 5); :180-185 (test 7)
- **description:** TASK-700 updated test fixtures in cyboflowStore.test.ts to satisfy the tightened discriminated `StreamEvent` union by changing the envelope `type` from `system` to `unknown`. The fix compiles, but the inner `payload` shapes were not updated: test 5 sets `type: unknown` with `payload: { type: system }` (an actual system-shaped payload arriving on the `unknown` arm), and test 7 sets `type: unknown` with `payload: { source: run-B }` (no `type` field at all). These fixtures no longer represent what real IPC would deliver — in production an unknown envelope means `deriveEventType` could not classify the wire event, so the payload would be the raw unclassifiable wire shape, not a well-formed system event. The tests still verify what they need to (subscription teardown, callback routing) but the fixtures are now misleading for a reader.

Suspected tasks: TASK-700
- **suggested_action:** Either (a) use a payload shape that actually fails classification (e.g., `{ unrecognized_field: xyz }`) to reflect what `unknown` means in production, OR (b) restore the original `type: system` envelope using a valid `SystemInitEvent` payload that satisfies the tightened union. Option (b) is more faithful to the original test intent (these tests are not about unknown events at all) but requires constructing a valid SystemInitEvent literal.
- **resolved_by:** 
