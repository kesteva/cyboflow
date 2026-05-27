---
id: TASK-754
idea: SPRINT-038-compound-B1
status: in-flight
created: "2026-05-25T00:00:00Z"
files_owned:
  - main/src/database/models.ts
  - main/src/database/database.ts
  - main/src/services/sessionManager.ts
  - main/src/services/__tests__/sessionManagerRunIdMapping.test.ts
files_readonly:
  - main/src/database/migrations/009_sessions_run_id.sql
  - main/src/ipc/session.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/runExecutor.ts
  - main/src/services/taskQueue.ts
  - main/src/database/__tests__/cyboflowSchema.test.ts
  - main/src/database/__tests__/sessionsRunIdMigration.test.ts
  - frontend/src/components/SessionListItem.tsx
  - .soloflow/active/findings/SPRINT-038-findings.md
acceptance_criteria:
  - criterion: "`CreateSessionData` (main/src/database/models.ts) declares an optional `run_id?: string | null` field."
    verification: "grep -n 'run_id' main/src/database/models.ts shows the field inside `interface CreateSessionData`."
  - criterion: "`createSession` in `main/src/database/database.ts` includes `run_id` in the INSERT column list and binds `data.run_id ?? null`."
    verification: "grep -n 'INSERT INTO sessions' main/src/database/database.ts shows `run_id` in the column list and a matching `?` placeholder; the `.run(...)` argument list includes `data.run_id ?? null` (or equivalent NULL-coalescing) in the matching position."
  - criterion: "A round-trip INSERT with `run_id='flow-001'` reads back `session.runId === 'flow-001'`, and an INSERT with no `run_id` reads back `session.runId === null`."
    verification: pnpm --filter main exec vitest run main/src/services/__tests__/sessionManagerRunIdMapping.test.ts — both new fixtures-DB round-trip cases pass.
  - criterion: All existing main-process tests still pass.
    verification: pnpm --filter main test exits 0.
  - criterion: Type-check and lint stay clean.
    verification: pnpm typecheck exits 0; pnpm lint exits 0.
  - criterion: "Quick session creation via `sessions:create-quick` continues to persist `run_id = NULL` (regression guard)."
    verification: "Read `main/src/ipc/session.ts:322-353` — confirm `sessions:create-quick` never sets `data.run_id`. The new fixtures-DB round-trip case asserting `runId === null` on a no-run_id INSERT covers this."
depends_on: []
estimated_complexity: medium
epic: quick-session
test_strategy:
  needed: true
  justification: Augment the existing mapper unit-test file with two fixtures-DB round-trip cases that exercise the real SQLite INSERT/SELECT path — the original three mapper cases use mocks and could not catch the missing INSERT column (FIND-SPRINT-038-4 root cause).
  targets:
    - behavior: "INSERT into sessions with run_id='flow-001' round-trips through `db.createSession` → `sessionManager.getSession` to `session.runId === 'flow-001'`"
      test_file: main/src/services/__tests__/sessionManagerRunIdMapping.test.ts
      type: integration
    - behavior: INSERT into sessions WITHOUT supplying run_id round-trips to `session.runId === null` (default-NULL path used by every current caller)
      test_file: main/src/services/__tests__/sessionManagerRunIdMapping.test.ts
      type: integration
---
# Persist sessions.run_id on creation so future flow-owned sessions can render correctly

## Objective

Add the missing INSERT-column plumbing so that the `sessions.run_id` column added by migration 009 can actually be populated. Today every `sessions` row is created with `run_id = NULL` because `createSession` in `main/src/database/database.ts:2057` omits the column. The SessionListItem Quick badge predicate (`session.runId == null`) therefore fires for every session — but that is **architecturally honest today** because no code path in cyboflow currently creates a flow-owned session (RunLauncher creates `workflow_runs` rows; sessions are created independently via TaskQueue / quick-session / main-repo paths and none of them is run-owned). This task adds the column to the INSERT and to `CreateSessionData` so the plumbing is in place for the eventual flow-owned-session creation surface, and extends the existing mapper test with a fixtures-DB round-trip that proves the column actually persists.

This task explicitly does NOT introduce a new caller that passes a runId. The finding's sub-step (2) ("thread the active runId through into the createSession call") is descoped: a complete audit of `db.createSession` callers (`grep -n 'db\.createSession\|this.db.createSession' main/src`) shows only `sessionManager.ts:372`, which is reached from `TaskQueue.createSession` (regular sessions — isMainRepo=false, no runId), `getOrCreateMainRepoSession` (main repo — isMainRepo=true, no runId), and `sessions:create-quick` (quick — no runId). RunExecutor's `panelId === sessionId === runId` invariant operates on `workflow_runs.id`, not on `sessions.id`; there is no current code that materialises a flow-owned `sessions` row. Introducing one is a separate design decision (likely follow-up that extends `RunLauncher.launch()` to also INSERT a session row) and is out of scope here.

## Implementation Steps

1. **Confirm no caller exists today.** Run `grep -rn 'db\.createSession\|this\.db\.createSession' main/src --include='*.ts'`. Confirm the only production hits are in `main/src/services/sessionManager.ts` (positional-args mock in tests does not count). This is a sanity gate — if grep finds a new caller, stop and reassess scope.
2. **Extend `CreateSessionData`** (`main/src/database/models.ts:90-107`). Add `run_id?: string | null;` as the last field. Match the optional-with-explicit-null pattern already used by `Session.run_id` on line 70.
3. **Update the INSERT in `createSession`** (`main/src/database/database.ts:2057-2077`). Add `run_id` to the column list (e.g. after `commit_mode_settings`) and a matching `?` placeholder. Add `data.run_id ?? null` to the bound-args list in the matching position. Keep ordering deterministic — append at the end. Do NOT touch any of the other 17 columns.
4. **Verify no plumbing needed in `sessionManager.createSessionWithId`** (`main/src/services/sessionManager.ts:313-370`). The `sessionData: CreateSessionData = {...}` object literal does not need a `run_id:` entry — by leaving it absent the `data.run_id ?? null` binding in step 3 yields NULL, which is the current behavior and what every existing caller wants. Add a one-line comment above `sessionData` explaining why `run_id` is intentionally omitted today (no flow-owned-session creation surface exists; deferred to a follow-up task).
5. **Extend the regression test file** (`main/src/services/__tests__/sessionManagerRunIdMapping.test.ts`). Add a new `describe` block — `'DB round-trip — run_id INSERT persistence'` — that:
   - Imports `DatabaseService` from `../../database/database` and mirrors the bootstrap pattern from `main/src/database/__tests__/cyboflowSchema.test.ts:737-742` (mkdtempSync + setMigrationsDirForTesting + initialize); do not extract a shared helper in this task.
   - Seeds a project row directly via raw better-sqlite3 (same as cyboflowSchema.test.ts:748-750).
   - Case A: calls `svc.createSession({ id: 'sess-flow-1', name: ..., run_id: 'flow-001', ...minimum required fields })`, then `svc.getSession('sess-flow-1')`, then asserts the returned DbSession has `run_id === 'flow-001'`. Then constructs a `SessionManager` via the mock pattern already in the file (lines 69-80) and asserts `convertDbSessionToSession(dbSession).runId === 'flow-001'`.
   - Case B: calls `svc.createSession({ id: 'sess-quick-1', name: ..., /* no run_id */ ... })`, asserts `dbSession.run_id` is null/undefined, asserts the mapped `runId === null`.
   - Uses `afterEach` cleanup with `rmSync(tmpDir, { recursive: true, force: true })`.
6. **Run the focused test:** `pnpm --filter main exec vitest run main/src/services/__tests__/sessionManagerRunIdMapping.test.ts`. All 5 cases (3 original + 2 new) must pass.
7. **Run the full main-process suite:** `pnpm --filter main test`. Must exit 0. If `better-sqlite3` NODE_MODULE_VERSION errors fire, run `pnpm rebuild better-sqlite3` first (per CLAUDE.md note on Electron-vs-Node ABI mismatch).
8. **Run `pnpm typecheck` and `pnpm lint`.** Both must exit 0.

## Acceptance Criteria

See frontmatter.

## Hardest Decision

Whether to introduce a flow-owned-session caller in this same task (i.e., extend `RunLauncher.launch()` or `RunExecutor.execute()` to also INSERT a session row keyed on runId). Decided AGAINST: that is a separate architectural decision involving session ↔ workflow_run coupling. Introducing the caller without first deciding whether sessions and workflow_runs *should* share an ID is exactly the silent-coupling we want to avoid. This task adds the plumbing only; the next sprint can decide on the caller.

## Rejected Alternatives

1. **Promote `run_id` to a required field on `CreateSessionData`.** Rejected — every existing caller would have to pass `null` explicitly; the `?? null` coalesce in step 3 handles the default identically. `Session.run_id?: string | null` already establishes the optional-with-explicit-null convention.
2. **Add a `run_id?: string` parameter to `sessionManager.createSession` / `createSessionWithId` in this task.** Rejected — those signatures already carry 14 positional parameters; adding another is the wrong direction. When a caller actually needs to pass a runId, switch those methods to an options-object signature first. Out of scope here.
3. **Inline the round-trip test into `cyboflowSchema.test.ts`.** Rejected — the test's primary subject is the mapper, not the schema. Co-located with the other mapper cases in `sessionManagerRunIdMapping.test.ts` makes the regression intent obvious.

## Lowest Confidence Area

The `sessionData` literal in `sessionManager.createSessionWithId` (step 4). The decision to leave `run_id` absent is correct *today* — but if the executor reasonably reads it as "you forgot to plumb it through", they may add a parameter, which is the exact refactor this plan explicitly defers. The inline comment added in step 4 mitigates this.
