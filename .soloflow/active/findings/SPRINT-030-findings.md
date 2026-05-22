---
sprint: SPRINT-030
pending_count: 3
last_updated: "2026-05-22T01:05:00.000Z"
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
