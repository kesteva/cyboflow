---
id: TASK-813
idea: IDEA-030
status: ready
created: 2026-06-02T00:00:00Z
source: IDEA-030
epic: interactive-persistent-terminal
files_owned:
  - main/src/orchestrator/runQueries.ts
  - main/src/orchestrator/__tests__/listRunsHandler.test.ts
files_readonly:
  - shared/types/workflows.ts
  - frontend/src/stores/activeRunsStore.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - shared/types/substrate.ts
  - main/src/database/migrations/013_workflow_run_substrate.sql
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
acceptance_criteria:
  - criterion: "listRunsHandler's SELECT in runQueries.ts includes the `substrate` column so cyboflow.runs.list rows carry it end-to-end. A seeded interactive run returns substrate==='interactive'; a legacy/null run reads back 'sdk' (the migration-013 NOT NULL DEFAULT 'sdk')."
    verification: "grep -n 'substrate' main/src/orchestrator/runQueries.ts:24-33 shows `substrate` in the SELECT column list; pnpm --filter main test listRunsHandler asserts an interactive-seeded run returns substrate==='interactive' and a default/legacy run returns 'sdk'."
  - criterion: "WorkflowRunListRow is returned UNCHANGED in shape — no new field is added to the type (substrate? at shared/types/workflows.ts:78 already exists) and the SELECT result cast stays `as WorkflowRunListRow[]` (no `any`, no double-cast)."
    verification: "grep -n 'as WorkflowRunListRow\\[\\]' main/src/orchestrator/runQueries.ts:32 shows the unchanged cast; git diff --stat shows 0 changed lines on shared/types/workflows.ts; pnpm typecheck exits 0 with zero edits to shared/types/workflows.ts."
  - criterion: "The tRPC runs.list output type and the renderer store are reached with ZERO edits: runs.ts list already declares `: WorkflowRunListRow[]` (runs.ts:211) and ActiveRunRow extends the RouterOutputs-inferred WorkflowRunListRow (activeRunsStore.ts:47,74), so activeRun.substrate populates to CyboflowRoot purely from this one column. No renderer or router edits in this task."
    verification: "git diff --name-only shows ONLY main/src/orchestrator/runQueries.ts and main/src/orchestrator/__tests__/listRunsHandler.test.ts changed; grep -n 'WorkflowRunListRow\\[\\]' main/src/orchestrator/trpc/routers/runs.ts:211 confirms the output type is already inferred unchanged."
  - criterion: "Standalone-typecheck invariant preserved: runQueries.ts adds NO imports from electron/better-sqlite3/main services — only the existing DatabaseLike + WorkflowRunListRow imports remain."
    verification: "grep -n 'import' main/src/orchestrator/runQueries.ts shows only `./types` (DatabaseLike) and `../../../shared/types/workflows` (WorkflowRunListRow); grep -nE \"from '(electron|better-sqlite3)'|services/\" main/src/orchestrator/runQueries.ts returns 0 matches."
  - criterion: "The listRunsHandler test seeds the substrate column via migration 013's ALTER (additive, NOT by mutating GATE_SCHEMA or the shared seedRun fixture) so the parity-pinned base schema and orchestratorTestDb.ts stay byte-identical."
    verification: "git diff --stat shows 0 changed lines on main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts and main/src/database/__test_fixtures__/registrySchema.ts; grep -n 'ADD COLUMN substrate' main/src/orchestrator/__tests__/listRunsHandler.test.ts shows the ALTER applied inside the test's own setup."
  - criterion: "No use of the `any` type in any file this task owns."
    verification: "grep -nE ':\\s*any(\\b|\\[)|<any>|as any' main/src/orchestrator/runQueries.ts main/src/orchestrator/__tests__/listRunsHandler.test.ts returns 0 matches."
  - criterion: "Full unit gate green and types/lint clean."
    verification: "pnpm test:unit exits 0 (one-shot vitest run, NOT test:e2e) with listRunsHandler.test.ts included; pnpm typecheck && pnpm lint exit 0."
depends_on: []
estimated_complexity: XS
test_strategy:
  needed: true
  justification: "This is a one-line load-bearing data plumb: the single column that makes run.substrate flow from the DB through cyboflow.runs.list to ActiveRunRow and into CyboflowRoot, which the entire interactive-terminal gate (IT-3..IT-7) keys off. A column silently dropped from the SELECT is exactly the FIND-SPRINT-024-4 silent-drop class the codebase guards against, so the SELECT-surfaces-substrate behavior MUST be locked by a test rather than assumed. The existing listRunsHandler.test.ts (newest-first, projectId-scoping, policy_json-exclusion) is the natural anchor; we extend it with a substrate round-trip case (interactive vs legacy-default) seeded via migration 013's additive ALTER."
  targets:
    - behavior: "listRunsHandler returns substrate==='interactive' for a run seeded with substrate='interactive' and 'sdk' for a run inserted without a substrate value (migration-013 NOT NULL DEFAULT 'sdk' floor), proving the column is surfaced end-to-end and legacy rows read back 'sdk'."
      test_file: "main/src/orchestrator/__tests__/listRunsHandler.test.ts"
      type: unit
---

# Surface run.substrate to the renderer (list query + ActiveRunRow inference)

## Objective

Add the `substrate` column to the `listRunsHandler` SELECT in `main/src/orchestrator/runQueries.ts:24-32` so every `cyboflow.runs.list` row carries it end-to-end. This is the single load-bearing data plumb that unblocks the interactive-terminal gate for the rest of IDEA-030 (IT-3..IT-7 all branch on `activeRun.substrate === 'interactive'`).

Everything downstream is ALREADY in place and stays untouched: `WorkflowRunListRow.substrate?` exists (`shared/types/workflows.ts:78`); the tRPC `runs.list` procedure already declares its output `: WorkflowRunListRow[]` (`runs.ts:211`); the renderer's `ActiveRunRow extends WorkflowRunListRow` where `WorkflowRunListRow` is inferred from `RouterOutputs` (`activeRunsStore.ts:47,74`); and `CyboflowRoot` already resolves `activeRun` from `runsByProject` (`CyboflowRoot.tsx:61-63`). So adding this one column makes `activeRun.substrate` populate to `CyboflowRoot` with NO type edits and NO renderer edits. Legacy rows read back `'sdk'` because migration 013 declares `substrate TEXT NOT NULL DEFAULT 'sdk'` (`013_workflow_run_substrate.sql:27-28`). The SELECT result cast stays `as WorkflowRunListRow[]` — no `any`, no double-cast. The standalone-typecheck invariant on `runQueries.ts` (no electron/better-sqlite3/services imports) is preserved.

## Implementation Steps

1. **Add `substrate` to the SELECT column list in `runQueries.ts:26-27`.** The current SELECT is:
   ```
   SELECT id, workflow_id, project_id, status, worktree_path, branch_name,
          created_at, updated_at, started_at, ended_at, stuck_reason
     FROM workflow_runs
   ```
   Insert `substrate` into the projection (e.g. after `stuck_reason`, or grouped with the other run-metadata columns). The returned cast at `runQueries.ts:32` stays exactly `as WorkflowRunListRow[]` — `WorkflowRunListRow` already declares `substrate?: CliSubstrate` (`shared/types/workflows.ts:71-78`), so the new column lands on a field that already exists and the cast remains sound with no widening. Do NOT touch the imports (`runQueries.ts:7-8` — only `DatabaseLike` from `./types` and `WorkflowRunListRow` from `../../../shared/types/workflows`); do NOT add a zod schema or a runtime narrow. This is a pure SQL-projection edit.

2. **Confirm the type + router + store need ZERO edits (verification, not a write).** `WorkflowRunListRow.substrate?` exists at `shared/types/workflows.ts:78`; the `runs.list` procedure already returns `: WorkflowRunListRow[]` at `runs.ts:211` (so the tRPC output type already infers `substrate?`); `activeRunsStore.ts:47` derives `WorkflowRunListRow` from `RouterOutputs['cyboflow']['runs']['list'][number]` and `ActiveRunRow extends WorkflowRunListRow` at line 74. `buildActiveRunRows` spreads `...run` (`activeRunsStore.ts:124-127`), so `substrate` flows through to each `ActiveRunRow`, and `CyboflowRoot` already reads `activeRun` (`CyboflowRoot.tsx:61-63`). Confirm via `git diff --name-only` that ONLY `runQueries.ts` and its test changed. Do NOT edit `shared/types/workflows.ts`, `runs.ts`, `activeRunsStore.ts`, or `CyboflowRoot.tsx` — they are read-only here.

3. **Extend `main/src/orchestrator/__tests__/listRunsHandler.test.ts` with a substrate round-trip case.** The existing file (lines 51-119) uses `createTestDb()` from `orchestratorTestDb.ts`, which applies `GATE_SCHEMA` — and `GATE_SCHEMA`'s `workflow_runs` table (`registrySchema.ts:33-50`) does NOT include the `substrate` column (it is a parity-pinned base schema; migration 013 adds the column on the live DB). So the new test MUST apply migration 013's ALTER additively inside its OWN setup, exactly mirroring how the fixture layers migration 007's `stuck_detected_at` (`orchestratorTestDb.ts:68-69`):
   ```ts
   db.exec(
     "ALTER TABLE workflow_runs ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk' CHECK (substrate IN ('sdk','interactive'))",
   );
   ```
   Do NOT modify the shared `orchestratorTestDb.ts` fixture or `GATE_SCHEMA`/`registrySchema.ts` (the GATE_SCHEMA parity test in `orchestratorTestDb.test.ts` would drift). Keep the ALTER local to this test's `beforeEach` (or a dedicated `describe` block's setup) so the rest of the suite is unaffected. Note: the existing shared `seedRun` helper inserts no `substrate` value, which is the legacy path — those rows correctly read back `'sdk'` from the column default.

4. **Add two assertions in the new case.** (a) Seed an interactive run by inserting a `workflow_runs` row with `substrate='interactive'` directly via SQL (a local seed helper that includes the `substrate` column, since the shared `seedRun` omits it) and assert `listRunsHandler(adapter, projectId)` returns a row with `substrate === 'interactive'`. (b) Seed a run WITHOUT a substrate value (the shared `seedRun`, or an INSERT that omits the column) and assert the returned row exposes `substrate === 'sdk'` — proving the migration-013 NOT NULL DEFAULT floor surfaces for legacy/default rows. Use `dbAdapter(db)` (`listRunsHandler.test.ts:16,62`) for the `DatabaseLike` surface as the existing cases do. No `any` — type the seed helper parameters explicitly (`Database.Database`, `string`, `number`).

5. **Run the gates.** Run the no-`any` grep over the two owned files, then `pnpm --filter main test listRunsHandler` (the named vitest), then `pnpm test:unit` (exit 0), then `pnpm typecheck && pnpm lint`. If `better-sqlite3` raises `NODE_MODULE_VERSION`, run `pnpm rebuild better-sqlite3` before the main vitest run per CLAUDE.md.

## Acceptance Criteria notes

- **This is the ONLY data-plumb in IT-1 — keep it surgical.** The decomposition is explicit that there are NO type edits and NO renderer edits in this task. The reason the single SELECT column is sufficient is the chain `WorkflowRunListRow.substrate? (already declared) → runs.list `: WorkflowRunListRow[]` (already typed) → RouterOutputs inference → ActiveRunRow extends WorkflowRunListRow → buildActiveRunRows spreads ...run → CyboflowRoot reads activeRun`. If any link in that chain required an edit, that would be a pre-existing regression to surface, not new work for this task.
- **Legacy rows read 'sdk', and that is the migration's job, not a code default.** Do NOT add a `?? 'sdk'` coalesce in `runQueries.ts` or the handler — the column's `NOT NULL DEFAULT 'sdk'` (`013_workflow_run_substrate.sql:27`) guarantees every row, including pre-013 rows backfilled by the ALTER, returns a non-null `'sdk'`. The test asserts this directly.
- **The test schema gap is the one real subtlety.** GATE_SCHEMA (the parity-pinned base) omits `substrate`, so a naive `createTestDb()` + raw SELECT of `substrate` would throw `no such column`. The fix is to apply migration 013's ALTER inside the test's own setup (the additive pattern the fixture already uses for migrations 007 and 010), NEVER by widening GATE_SCHEMA or the shared fixture — that would break the GATE_SCHEMA parity test.
- **No-`any` and standalone-typecheck invariants are CI-enforced.** The cast stays `as WorkflowRunListRow[]`; `runQueries.ts` imports stay limited to `DatabaseLike` + `WorkflowRunListRow`.

## Out of Scope

- Any edit to `shared/types/workflows.ts` — `substrate?: CliSubstrate` already exists on `WorkflowRunListRow` (line 78) and on `WorkflowRunRow` (line 51). Widening the type is explicitly NOT this task.
- Any edit to the renderer (`activeRunsStore.ts`, `CyboflowRoot.tsx`) or the tRPC router (`runs.ts`). They already infer/surface `substrate` once the column is in the SELECT. Consuming `activeRun.substrate` to actually SWAP the chat view to the interactive terminal is IT-3 (TASK-815) / IT-4 (TASK-816), not here.
- The raw-PTY backend pipeline (`pty-output` emit → SubstrateDispatchFacade fan-in → ptyPublisher → `cyboflow:pty:` channel → preload allowlist) — that is IT-2 (TASK-814), which owns `interactiveClaudeManager.ts`, `substrateDispatchFacade.ts`, `index.ts`, `preload.ts`.
- The `InteractiveTerminalView` / xterm wiring, `subscribeToPtyBytes`, `RunChatView` transcript swap, the INTERACTIVE pill / LIVE PTY bar chrome, and the first-interaction warn dialog — IT-3/IT-4 (TASK-815/816).
- `sendTurn` / live-input relay, the runs mutation, composer relay, Interact-anyway keystroke relay, and PTY resize — IT-5 (TASK-817).
- The persistence/completion rework (gate the turn-end EOF/'/exit' kill behind the persistent flag, route the turn-end event through SubstrateDispatchFacade to a new RunExecutor handler that calls `restAwaitingReview` WITHOUT resolving the spawn promise, make explicit End/Merge/Dismiss the only spawn-promise resolver, keep the SDK path byte-identical) — IT-6 (TASK-818). This task touches NONE of `runExecutor.ts`, `interactiveClaudeManager.ts`, or the completion model.
- The interactive approval-gate wiring (call `InteractiveSettingsWriter.write` on spawn, implement the `denyInFlightShellApprovals`/`removeGeneratedSettings` teardown stubs) — IT-7 (TASK-819).
- Modifying the shared `orchestratorTestDb.ts` fixture, `GATE_SCHEMA`, or `seedRun` — the substrate column is applied additively inside this task's own test setup; the parity-pinned fixtures stay byte-identical.
- A `pnpm test:e2e` gate — the verifier gate is `pnpm test:unit` per CLAUDE.md.
