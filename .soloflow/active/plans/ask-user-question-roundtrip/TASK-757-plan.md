---
id: TASK-757
idea: IDEA-025
status: ready
created: "2026-05-26T00:00:00Z"
files_owned:
  - shared/types/questions.ts
  - main/src/database/migrations/010_questions.sql
  - shared/types/cyboflow.ts
  - main/src/services/cyboflow/stateMachine.ts
  - main/src/services/cyboflow/__tests__/stateMachine.test.ts
  - main/src/database/schema.sql
  - main/src/database/__tests__/migration010.test.ts
  - main/src/orchestrator/__tests__/stuckDetector.test.ts
  - approvals.ts
files_readonly:
  - shared/types/approvals.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
  - main/src/database/migrations/009_sessions_run_id.sql
  - main/src/orchestrator/stuckDetector.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/database/database.ts
  - main/src/database/__tests__/cyboflowSchema.test.ts
  - main/src/database/__tests__/migration007.test.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/services/cyboflow/transitions.ts
  - .soloflow/active/ideas/IDEA-025.md
  - .soloflow/active/research/IDEA-025-research.md
acceptance_criteria:
  - criterion: "`shared/types/questions.ts` exists and exports four wire types — `Question`, `QuestionAnswer`, `QuestionCreatedEvent`, `QuestionAnsweredEvent` — modeled on the `shared/types/approvals.ts` pattern (pure type module, zero runtime imports)."
    verification: "grep -nE 'export (interface|type) (Question|QuestionAnswer|QuestionCreatedEvent|QuestionAnsweredEvent)\\b' shared/types/questions.ts returns at least 4 lines. grep -nE \"^import [^t]\" shared/types/questions.ts returns 0 matches (only `import type` allowed, mirroring approvals.ts which has no runtime imports)."
  - criterion: "`Question` includes the fields required by the IDEA wire contract: `id: string`, `runId: string`, `toolUseId: string`, `questions` (the SDK `AskUserQuestionInput['questions']` payload — 1–4 entries each with `question`, `header`, `multiSelect`, `options[2-4]`), `status: 'pending' | 'answered' | 'timed_out'`, `createdAt: string`, `answeredAt: string | null`, `answerJson: string | null`."
    verification: "grep -nE 'id: string|runId: string|toolUseId: string|status:|createdAt: string|answeredAt: string' shared/types/questions.ts confirms every field present. `pnpm --filter shared run typecheck` (or equivalent root typecheck) succeeds."
  - criterion: "`QuestionAnswer` encodes the SDK return shape: an `answers` map keyed by question text (`Record<string, string>`) plus optional `annotations` map (`Record<string, { preview?: string; notes?: string }>`), matching `AskUserQuestionOutput` from `sdk-tools.d.ts:2620` (cited in IDEA-025-research §API Documentation)."
    verification: "grep -nE 'answers: Record<string, string>|annotations\\?' shared/types/questions.ts shows both fields. `pnpm typecheck` succeeds."
  - criterion: "`shared/types/cyboflow.ts` `WorkflowRunStatus` union includes `'awaiting_input'` as a member alongside the eight pre-existing statuses."
    verification: "grep -nE \"'awaiting_input'\" shared/types/cyboflow.ts returns exactly 1 line (the new union member). The file still compiles under `pnpm typecheck` with no `Type 'awaiting_input' is not assignable` errors elsewhere."
  - criterion: "`main/src/services/cyboflow/stateMachine.ts` `ALLOWED_TRANSITIONS` covers `awaiting_input` as a source state with `running` and `canceled` as the only legal targets, and `running` gains `awaiting_input` as an additional target."
    verification: "grep -nE 'awaiting_input:' main/src/services/cyboflow/stateMachine.ts returns exactly 1 line (the new source-state entry). grep -nE \"running: *\\[\" main/src/services/cyboflow/stateMachine.ts shows `'awaiting_input'` inside the `running:` array. `pnpm typecheck` succeeds — the `Record<WorkflowRunStatus, …>` type requires every union member as a key."
  - criterion: "`main/src/services/cyboflow/__tests__/stateMachine.test.ts` `ALL_STATUSES` array contains all 9 statuses (including `'awaiting_input'`), the `entries.toHaveLength` assertion is updated to 9, and at least two new tests cover the `awaiting_input` transitions (running -> awaiting_input allowed; awaiting_input -> completed forbidden; awaiting_input -> running allowed)."
    verification: "grep -nE \"'awaiting_input'\" main/src/services/cyboflow/__tests__/stateMachine.test.ts returns at least 3 lines. grep -nE 'toHaveLength\\(9\\)' main/src/services/cyboflow/__tests__/stateMachine.test.ts returns 1 line. grep -nE 'toHaveLength\\(8\\)' main/src/services/cyboflow/__tests__/stateMachine.test.ts returns 0 lines. `pnpm --filter main test -- --run stateMachine` passes."
  - criterion: "`main/src/database/migrations/010_questions.sql` exists and (a) creates the `questions` table with columns `id TEXT PRIMARY KEY`, `run_id TEXT NOT NULL` (FK to workflow_runs.id ON DELETE CASCADE), `tool_use_id TEXT NOT NULL`, `questions_json TEXT NOT NULL`, `answer_json TEXT`, `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'timed_out'))`, `created_at DATETIME DEFAULT CURRENT_TIMESTAMP`, `answered_at DATETIME`; (b) rebuilds `workflow_runs` via the create-new-table + copy + DROP + RENAME recipe with the 9-status CHECK constraint including `'awaiting_input'`; (c) re-creates all three pre-existing indexes on workflow_runs (`idx_workflow_runs_status_created`, `idx_workflow_runs_workflow_id`, `idx_workflow_runs_status_stuck_at`); (d) creates a day-1 index `idx_questions_status_created` on (status, created_at)."
    verification: "test -f main/src/database/migrations/010_questions.sql. grep -cE 'CREATE TABLE.*questions' main/src/database/migrations/010_questions.sql >= 1. grep -cE 'awaiting_input' main/src/database/migrations/010_questions.sql == 1 (only the new CHECK constraint mentions it). grep -cE 'CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created' main/src/database/migrations/010_questions.sql >= 1. grep -cE 'CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id' main/src/database/migrations/010_questions.sql >= 1. grep -cE 'CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_stuck_at' main/src/database/migrations/010_questions.sql >= 1. grep -cE 'CREATE INDEX IF NOT EXISTS idx_questions_status_created' main/src/database/migrations/010_questions.sql == 1. grep -cE 'PRAGMA foreign_keys=OFF' main/src/database/migrations/010_questions.sql >= 1."
  - criterion: "`main/src/database/schema.sql` `workflow_runs.status` CHECK constraint includes `'awaiting_input'` so fresh-install state matches post-010 state without relying on migration 010 to rebuild it."
    verification: "grep -nE \"CHECK \\(status IN \\('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled', 'awaiting_input'\\)\\)\" main/src/database/schema.sql returns exactly 1 line."
  - criterion: "`main/src/database/__tests__/migration010.test.ts` exists and proves four invariants against an in-memory SQLite instance: (a) applying 006+007+010 yields a `questions` table with the correct column set; (b) post-010 workflow_runs accepts `'awaiting_input'` as a status; (c) post-010 workflow_runs still accepts every original 8-status value (data preservation through the table rebuild); (d) all three pre-existing workflow_runs indexes still exist after the rebuild."
    verification: test -f main/src/database/__tests__/migration010.test.ts. `pnpm --filter main test -- --run migration010` exits 0 with at least 4 passing tests.
  - criterion: "`main/src/orchestrator/__tests__/stuckDetector.test.ts` includes a new test proving an `awaiting_input` workflow_run with a stale pending approval is NOT classified stuck — the existing SQL UPDATE guard `WHERE id = ? AND status = 'awaiting_review'` already excludes it."
    verification: "grep -nE \"awaiting_input\" main/src/orchestrator/__tests__/stuckDetector.test.ts returns at least 1 line (the new test). The `seedRun` helper's status union literal includes `'awaiting_input'`. `pnpm --filter main test -- --run stuckDetector` passes."
  - criterion: Whole-repo typecheck and unit-test gates are green.
    verification: "`pnpm typecheck` exits 0. `pnpm test:unit` exits 0."
depends_on: []
estimated_complexity: low
epic: ask-user-question-roundtrip
test_strategy:
  needed: true
  justification: "This task introduces (a) a SQL CHECK-constraint rebuild via the table-recreation recipe (high-risk: must preserve data and indexes), (b) a new union member to the WorkflowRunStatus discriminant which ripples into the state machine, and (c) a new DB table. Each surface has a clear test target. Sibling-test scan confirmed: `main/src/database/__tests__/cyboflowSchema.test.ts`, `migration007.test.ts`, `sessionsRunIdMigration.test.ts`, and `fileMigrationRunner.test.ts` are siblings of the new migration file; the existing test patterns are direct templates."
  targets:
    - behavior: Migration 010 creates the questions table with the documented column set and CHECK constraint on status.
      test_file: main/src/database/__tests__/migration010.test.ts
      type: integration
    - behavior: "After applying 006+007+010, workflow_runs.status accepts 'awaiting_input' as a valid value."
      test_file: main/src/database/__tests__/migration010.test.ts
      type: integration
    - behavior: "After applying 006+007+010, workflow_runs.status still accepts all 8 original status values — i.e. the table rebuild did not narrow the CHECK constraint."
      test_file: main/src/database/__tests__/migration010.test.ts
      type: integration
    - behavior: "After applying 006+007+010, all three pre-existing workflow_runs indexes (idx_workflow_runs_status_created, idx_workflow_runs_workflow_id, idx_workflow_runs_status_stuck_at) still exist."
      test_file: main/src/database/__tests__/migration010.test.ts
      type: integration
    - behavior: "running -> awaiting_input is an allowed transition; awaiting_input -> running is allowed; awaiting_input -> canceled is allowed; awaiting_input -> completed is forbidden (must return to running first)."
      test_file: main/src/services/cyboflow/__tests__/stateMachine.test.ts
      type: unit
    - behavior: ALLOWED_TRANSITIONS covers all 9 statuses and ALL_STATUSES enumerates all 9.
      test_file: main/src/services/cyboflow/__tests__/stateMachine.test.ts
      type: unit
    - behavior: "A workflow_run in 'awaiting_input' status with a stale pending approval is NOT classified as stuck by StuckDetector — the existing SQL UPDATE `WHERE id = ? AND status = 'awaiting_review'` guard architecturally excludes it. This is a regression test for the IDEA-025 Q2 resolution."
      test_file: main/src/orchestrator/__tests__/stuckDetector.test.ts
      type: integration
---
# Shared Question types and DB migration 010

## Objective

Seed the `ask-user-question-roundtrip` epic with the wire-type contract and database schema that every subsequent task in the epic depends on. This task ships (a) `shared/types/questions.ts` — pure-type wire contracts for the renderer ↔ main tRPC boundary, modeled on `approvals.ts`; (b) `migration 010` — adds the `questions` table and rebuilds `workflow_runs` with `'awaiting_input'` in the CHECK constraint via SQLite's create-new-table + copy + swap recipe; (c) the TypeScript-side widening of `WorkflowRunStatus` and the matching `ALLOWED_TRANSITIONS` entry so the entire compile chain stays green. No router, hook, or UI is implemented — all of those land in TASK-758 / TASK-759 / TASK-760.

## Implementation Steps

### Step 1 — Create `shared/types/questions.ts`

Create a new pure-type module that mirrors the structure of `shared/types/approvals.ts`. Header docblock must explicitly state: "Pure type module: NO runtime imports" — the approvals.ts invariant is preserved.

Exports (use the SDK schemas from `IDEA-025-research §API Documentation` as the authoritative shape source):

```ts
// shared/types/questions.ts — header docblock per approvals.ts pattern

/** A single AskUserQuestion entry as carried in the SDK's AskUserQuestionInput.questions array. */
export interface QuestionPayload {
  /** The full question text. Doubles as the key in QuestionAnswer.answers. */
  question: string;
  /** Short chip-style label, ≤12 chars per Anthropic SDK contract. */
  header: string;
  /** Whether the user may pick multiple options. */
  multiSelect: boolean;
  /** 2–4 options per the SDK constraint. */
  options: ReadonlyArray<{
    label: string;
    description?: string;
    /** Markdown when toolConfig.askUserQuestion.previewFormat === 'markdown'. Absent unless that option is set. */
    preview?: string;
  }>;
}

/**
 * A single question gate as seen by the renderer.
 * Populated from the `questions` DB table via `cyboflow.questions.listPending`.
 */
export interface Question {
  /** UUID — matches `questions.id` in the database. */
  id: string;
  /** Foreign key to `workflow_runs.id`. */
  runId: string;
  /** SDK tool_use_id that produced this question — used to correlate the answer back to the tool call. */
  toolUseId: string;
  /** The 1–4 questions in this AskUserQuestion call. */
  questions: ReadonlyArray<QuestionPayload>;
  /** Current lifecycle state. */
  status: 'pending' | 'answered' | 'timed_out';
  /** ISO-8601 UTC timestamp when the question gate was created. */
  createdAt: string;
  /** ISO-8601 timestamp of the answer, or null while pending. */
  answeredAt: string | null;
  /** Serialized QuestionAnswer once answered, or null while pending. */
  answerJson: string | null;
}

/**
 * The shape the renderer sends back when answering. Mirrors the SDK's
 * AskUserQuestionOutput (sdk-tools.d.ts:2620 — cited in IDEA-025-research).
 *
 * Keys of `answers` are the full question text (NOT the header). Values are
 * the selected option's `label`. For multi-select, comma-join labels.
 * The implicit "Other" free-text answer is also a label string here.
 */
export interface QuestionAnswer {
  answers: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}

/** Emitted on `cyboflow.questions.onQuestionCreated`. */
export interface QuestionCreatedEvent {
  question: Question;
}

/** Emitted on `cyboflow.questions.onQuestionAnswered`. */
export interface QuestionAnsweredEvent {
  questionId: string;
  status: 'answered' | 'timed_out';
}
```

No `import` lines other than `import type` from other shared modules (none needed here). Keep the file scope tight — the in-flight pending-promise types and DB-row types belong in TASK-758's `questionRouter.ts`, not here.

### Step 2 — Widen `WorkflowRunStatus` in `shared/types/cyboflow.ts`

Append `'awaiting_input'` as a new variant of the `WorkflowRunStatus` union at the bottom of the existing alternation. Do NOT touch `TERMINAL_RUN_STATUSES` (awaiting_input is non-terminal) or any other export. Resulting union:

```ts
export type WorkflowRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'awaiting_review'
  | 'stuck'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'awaiting_input';
```

No comment block change needed; the surrounding comments still describe the schema correctly.

### Step 3 — Add `awaiting_input` to `ALLOWED_TRANSITIONS` in `main/src/services/cyboflow/stateMachine.ts`

`Record<WorkflowRunStatus, readonly WorkflowRunStatus[]>` requires every union member as a key — TypeScript will fail compilation otherwise. Add the new entry and extend `running:` to include the new target.

```ts
export const ALLOWED_TRANSITIONS: Record<
  WorkflowRunStatus,
  readonly WorkflowRunStatus[]
> = {
  queued:          ['starting', 'canceled'],
  starting:        ['running', 'failed', 'canceled'],
  running:         ['awaiting_review', 'awaiting_input', 'completed', 'failed', 'canceled', 'stuck'],
  awaiting_review: ['running', 'canceled', 'stuck', 'failed'],
  awaiting_input:  ['running', 'canceled', 'failed'],
  stuck:           ['running', 'canceled', 'failed'],
  completed:       [],
  failed:          [],
  canceled:        [],
};
```

Rationale for the chosen edges (record in the implementation diff so reviewers don't have to reconstruct it):

- `running -> awaiting_input`: the only way to enter the new state — QuestionRouter transitions atomically with the question INSERT (TASK-758).
- `awaiting_input -> running`: the symmetric return when QuestionRouter.respond resolves.
- `awaiting_input -> canceled`: user / system cancellation while a question is in flight.
- `awaiting_input -> failed`: defensive — the SDK loop crashed mid-question and the executor finalizes the run.

`awaiting_input -> stuck` is intentionally NOT allowed: per IDEA-025 Q2 resolution, awaiting_input runs are exempt from stuck classification. The StuckDetector's existing SQL guard (`WHERE id = ? AND status = 'awaiting_review'`) enforces this at the data layer; the state-machine table reflects the same invariant at the type layer.

### Step 4 — Update `main/src/services/cyboflow/__tests__/stateMachine.test.ts`

- Add `'awaiting_input'` to `ALL_STATUSES`.
- Change `expect(entries).toHaveLength(8)` to `expect(entries).toHaveLength(9)`.
- Add positive-sweep cases (in the existing "(a) positive sweep" describe block): `running -> awaiting_input`, `awaiting_input -> running`, `awaiting_input -> canceled`.
- Add negative-sweep cases (in the existing "(b) negative sweep" describe block): `awaiting_input -> completed` forbidden, `awaiting_input -> stuck` forbidden, `awaiting_input -> awaiting_review` forbidden.

Do not modify the terminal-state lockdown sweep block — its loop iterates `ALL_STATUSES`, so adding the new value to `ALL_STATUSES` is sufficient.

### Step 5 — Create `main/src/database/migrations/010_questions.sql`

Two parts inside a single `BEGIN; … COMMIT;` transaction. Use the exact pattern from `006_cyboflow_schema.sql` for table / index DDL style (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).

```sql
-- Migration 010: AskUserQuestion round-trip schema (IDEA-025).
--
-- Two parts inside a single transaction:
--   (1) New `questions` table — stores AskUserQuestion gates analogous to `approvals`.
--   (2) workflow_runs CHECK-constraint update — adds 'awaiting_input' via the
--       SQLite table-recreation recipe (no ALTER TABLE for CHECK constraints).
--
-- Risk 2 in .soloflow/active/research/IDEA-025-research.md documents the
-- table-recreation recipe; this migration is its concrete application.

-- ---------------------------------------------------------------------------
-- Part 1: questions table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  questions_json TEXT NOT NULL,             -- serialized QuestionPayload[]
  answer_json TEXT,                          -- serialized QuestionAnswer, null while pending
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'timed_out')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  answered_at DATETIME,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_questions_status_created ON questions(status, created_at);

-- ---------------------------------------------------------------------------
-- Part 2: workflow_runs CHECK-constraint update — add 'awaiting_input'.
--
-- SQLite has no ALTER TABLE … DROP/ADD CONSTRAINT. We use the canonical
-- create-new-table + copy + DROP + RENAME recipe. FK on approvals.run_id and
-- raw_events.run_id reference workflow_runs.id ON DELETE CASCADE, so
-- foreign_keys must be OFF for the duration to keep child rows intact.
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys=OFF;

CREATE TABLE workflow_runs_new (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled', 'awaiting_input')),
  permission_mode_snapshot TEXT NOT NULL DEFAULT 'default',
  worktree_path TEXT,
  branch_name TEXT,
  policy_json TEXT,
  stuck_at DATETIME,
  stuck_reason TEXT,
  stuck_detected_at INTEGER,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  ended_at DATETIME,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

INSERT INTO workflow_runs_new (
  id, workflow_id, project_id, status, permission_mode_snapshot,
  worktree_path, branch_name, policy_json, stuck_at, stuck_reason,
  stuck_detected_at, error_message, created_at, updated_at, started_at, ended_at
)
SELECT
  id, workflow_id, project_id, status, permission_mode_snapshot,
  worktree_path, branch_name, policy_json, stuck_at, stuck_reason,
  stuck_detected_at, error_message, created_at, updated_at, started_at, ended_at
FROM workflow_runs;

DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;

-- Re-create all three pre-existing indexes (006 day-1 indexes + 007's stuck index).
-- Tier 2 reconciler in database.ts:1388 historically missed idx_workflow_runs_status_stuck_at;
-- we restore all three here so post-010 state is fully indexed.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_stuck_at ON workflow_runs(status, stuck_detected_at);

PRAGMA foreign_keys=ON;
```

Note: do NOT wrap this in an explicit `BEGIN; … COMMIT;` block in the SQL file — `runFileBasedMigrations()` (database.ts:1591) already wraps every file in a `this.transaction(() => { this.db.exec(sql); … })`, so an inner BEGIN would nest. Use `PRAGMA foreign_keys=OFF` at the top of the file as shown; the outer transaction handles atomicity.

### Step 6 — Update `main/src/database/schema.sql`

Append `, 'awaiting_input'` inside the existing CHECK constraint on line 60 so fresh installs get the 9-status CHECK directly. This is purely a fresh-install optimization — migration 010 would rebuild the table to the 9-status shape anyway, but doing it once at install time avoids an unnecessary rebuild and keeps schema.sql visually accurate.

```sql
status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled', 'awaiting_input')),
```

Do NOT touch `main/src/database/__test_fixtures__/registrySchema.ts` — it intentionally mirrors 006 (pre-010) state for fixture-based tests. Do NOT touch `main/src/database/database.ts`'s `reconcileWorkflowRunsSchema` Tier 2 rebuild path — it only fires on a legacy drift condition (`worktree_path` declared NOT NULL) that doesn't apply post-010. See Lowest Confidence Area.

### Step 7 — Create `main/src/database/__tests__/migration010.test.ts`

Pattern after `migration007.test.ts`. Apply 006 + 007 + 010 in order to a fresh `:memory:` DB, then assert:

```ts
// migration010.test.ts skeleton

describe('Migration 010: questions table + workflow_runs awaiting_input CHECK', () => {
  it('creates questions table with expected columns', () => {
    const db = applyMigrations006To010();
    const cols = db.prepare('PRAGMA table_info(questions)').all() as TableInfoRow[];
    const names = new Set(cols.map(c => c.name));
    expect(names).toEqual(new Set([
      'id', 'run_id', 'tool_use_id', 'questions_json', 'answer_json',
      'status', 'created_at', 'answered_at',
    ]));
  });

  it('questions.status CHECK rejects invalid values', () => {
    // … FK chain set-up: insert workflow + workflow_run …
    expect(() => db.prepare(
      `INSERT INTO questions (id, run_id, tool_use_id, questions_json, status)
       VALUES ('q-1', 'wr-1', 'tu-1', '[]', 'maybe')`
    ).run()).toThrow(/CHECK constraint failed/);
  });

  it('workflow_runs accepts awaiting_input after migration 010', () => {
    const db = applyMigrations006To010();
    // … seed workflow …
    expect(() => db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-ai', 'wf-1', 1, 'awaiting_input', 'default')`
    ).run()).not.toThrow();
  });

  it('workflow_runs still accepts all 8 original status values', () => {
    for (const status of ['queued', 'starting', 'running', 'awaiting_review',
                           'stuck', 'completed', 'failed', 'canceled']) {
      const db = applyMigrations006To010();
      // … seed workflow …
      expect(() => db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
         VALUES ('wr-1', 'wf-1', 1, ?, 'default')`
      ).run(status)).not.toThrow();
    }
  });

  it('preserves all three pre-existing workflow_runs indexes', () => {
    const db = applyMigrations006To010();
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflow_runs'"
    ).all() as Array<{ name: string }>;
    const names = new Set(rows.map(r => r.name));
    expect(names).toContain('idx_workflow_runs_status_created');
    expect(names).toContain('idx_workflow_runs_workflow_id');
    expect(names).toContain('idx_workflow_runs_status_stuck_at');
  });

  it('creates idx_questions_status_created index', () => { /* … */ });
});
```

Helper:

```ts
function applyMigrations006To010(): Database.Database {
  const db = new Database(':memory:');
  for (const n of ['006_cyboflow_schema.sql', '007_add_stuck_reason.sql', '010_questions.sql']) {
    db.exec(readFileSync(join(__dirname, '..', 'migrations', n), 'utf-8'));
  }
  return db;
}
```

Note: 009_sessions_run_id.sql ALTERs the `sessions` table which doesn't exist in 006's schema-set, so it would fail under a 006-only base. Skip 008 and 009 — migration 010's logic doesn't depend on them. The fileMigrationRunner integration is covered by the existing `fileMigrationRunner.test.ts`; this test is for the SQL contract only.

### Step 8 — Update `main/src/orchestrator/__tests__/stuckDetector.test.ts`

Widen the `seedRun` helper's status literal union to include `'awaiting_input'`:

```ts
status: 'running' | 'awaiting_review' | 'canceled' | 'completed' | 'failed' | 'stuck' | 'awaiting_input',
```

Add one new test (alongside the existing classification tests) that proves the exemption:

```ts
it('does NOT classify awaiting_input runs as stuck even when an associated approval is stale', () => {
  const rawDb = createTestDb({ includeStuckDetectedAt: true });
  const db = dbAdapter(rawDb);
  const emitter = new EventEmitter();
  const logger = makeSpyLogger();
  const events: StuckDetectedEvent[] = [];
  emitter.on('runs:stuck', (e: StuckDetectedEvent) => events.push(e));

  // Seed an awaiting_input run + a stale pending approval.
  seedRun(rawDb, 'run-ai', 'awaiting_input');
  rawDb.prepare(
    `INSERT INTO approvals (id, run_id, tool_name, tool_input_json, tool_use_id, status, created_at)
     VALUES ('a-stale', 'run-ai', 'Bash', '{}', 'tu-1', 'pending', ?)`,
  ).run(ageMsToIso(10 * 60_000));

  const detector = new StuckDetector({
    db,
    claudeManager: makeClaudeManager(),       // hasActiveRunForId returns false — classifies as orphan_pty
    emitter,
    logger,
  });
  await detector.scan();

  // The classifyStaleApproval call may classify the approval as orphan_pty,
  // but the UPDATE `WHERE id = ? AND status = 'awaiting_review'` won't match
  // (the run is in 'awaiting_input'), so changes === 0 and no event fires.
  expect(events).toHaveLength(0);
  // workflow_runs row stays in awaiting_input.
  const row = rawDb.prepare("SELECT status FROM workflow_runs WHERE id = ?").get('run-ai') as { status: string };
  expect(row.status).toBe('awaiting_input');

  rawDb.close();
});
```

Note: `createTestDb` from `orchestratorTestDb.ts` uses `GATE_SCHEMA` which has the pre-010 8-status CHECK. The INSERT of `'awaiting_input'` would FAIL that CHECK. So either (a) extend `createTestDb` options to accept `includeAwaitingInputStatus: true` and have it execute a follow-up CHECK-update statement, or (b) seed the run via `INSERT … status = 'running'` and then `UPDATE … SET status = 'awaiting_input'` — which would also fail the CHECK. The cleanest approach is (c): after `createTestDb` returns, run a raw `db.exec(...)` to rebuild the workflow_runs table to the 9-status CHECK inside the test setup (same recipe as migration 010, in a 3-line helper). Encode this helper inside the test file as `function widenWorkflowRunsCheckToNineStatuses(db: Database.Database)` and call it before the `seedRun(rawDb, 'run-ai', 'awaiting_input')` line. Do NOT modify `orchestratorTestDb.ts` itself — that's a shared fixture.

### Step 9 — Run the full verifier chain

```bash
pnpm typecheck
pnpm test:unit
```

Both must exit 0. The IPC + tRPC-router untouched-handler invariant from CLAUDE.md does not apply here (no IPC handlers, no tRPC procedures, no preload).

## Acceptance Criteria

See the frontmatter `acceptance_criteria` list. Pass/fail for each is the verification command provided. The whole-repo `pnpm typecheck` + `pnpm test:unit` gates are the catch-all — any mis-wired union or missing transition will surface there.

## Test Strategy

Per `test_strategy` in the frontmatter. Three test files are touched:

1. **New `main/src/database/__tests__/migration010.test.ts`** — proves the SQL contract: questions table shape, CHECK constraints, 9-status acceptance, 8-status preservation, three workflow_runs indexes preserved. Pattern: read each migration file and `db.exec()` it against `:memory:`, then assert via `PRAGMA table_info` and `sqlite_master`. Direct templates: `migration007.test.ts`, `cyboflowSchema.test.ts`.

2. **Updated `main/src/services/cyboflow/__tests__/stateMachine.test.ts`** — adds `'awaiting_input'` to `ALL_STATUSES`, updates `toHaveLength(8) → toHaveLength(9)`, adds positive cases (running -> awaiting_input, awaiting_input -> running, awaiting_input -> canceled) and negative cases (awaiting_input -> completed, awaiting_input -> stuck, awaiting_input -> awaiting_review). The terminal-state lockdown sweep is loop-driven over `ALL_STATUSES` so it picks up the new entry automatically.

3. **Updated `main/src/orchestrator/__tests__/stuckDetector.test.ts`** — adds a single regression test that seeds an `awaiting_input` run + a stale pending approval and asserts no `'runs:stuck'` event fires. Widens the `seedRun` helper's status union literal. Needs an inline `widenWorkflowRunsCheckToNineStatuses` helper because the test-DB fixture (`GATE_SCHEMA`) uses the pre-010 8-status CHECK — do not mutate `registrySchema.ts`.

No mocking infrastructure changes required.

## Hardest Decision

**Whether to update `main/src/database/database.ts`'s `reconcileWorkflowRunsSchema` Tier 2 rebuild (line 1388) to use the 9-status CHECK.**

That Tier 2 block hard-codes the 8-status CHECK and would only fire if a user's DB has `worktree_path` declared NOT NULL — a legacy drift case from pre-edit installs of migration 006. Post-migration 010, fresh installs and existing installs both have `worktree_path` nullable, so Tier 2 will not fire on any DB that has reached the canonical 010 shape. The risk that Tier 2 ever runs post-010 is low.

I chose NOT to update Tier 2 in this task because:

1. The pre-flight grep showed three other `CHECK (status IN …)` literals (database.ts:1388, schema.sql:60, registrySchema.ts:37). Touching all three would expand the change surface from "two files + types" to "five files + types" and pull in the Tier 2 rebuild's separate concerns (it also has a missing-index bug where `idx_workflow_runs_status_stuck_at` is not re-created).
2. The migration 010 itself fixes the missing-index bug forward.
3. If a user ever does hit Tier 2 post-010, the symptom is recoverable: the next `pnpm dev` boot would simply downgrade their CHECK back to 8-status — at which point a future `awaiting_input` insert would fail loudly with a CHECK violation, which is a recoverable test-time signal, not data loss.

A separate compound proposal post-merge could fix Tier 2 + add a regression test for it without conflating concerns. Surfaced explicitly in Lowest Confidence below.

## Rejected Alternatives

1. **Split the WorkflowRunStatus extension into a separate task downstream of TASK-757.** The decomposer's note offered this option. Rejected because: the migration 010 SQL CHECK and the TypeScript `WorkflowRunStatus` union are the same invariant in two languages — splitting them across two tasks means there's a state of the repo where the SQL allows `'awaiting_input'` but the TypeScript union does not (or vice versa), causing typecheck to fail on any code that touches a `WorkflowRunStatus` value at runtime. The atomic-coupling is intrinsic. The cost of the wider files_owned is acceptable because the changes are mechanical (one new union member, one new `ALLOWED_TRANSITIONS` entry, one test array update).

2. **Use `ALTER TABLE` with a separate raw-status column instead of the table-recreation recipe.** Reconsidered after seeing how invasive the rebuild is. Rejected because SQLite genuinely does not support modifying CHECK constraints in-place, and adding a redundant column with no constraint would defeat the purpose of having the constraint in the first place. The research report cites this as a known SQLite limitation (Risk 2).

3. **Skip schema.sql and let migration 010 do all the work for fresh installs too.** Considered because schema.sql + migration 010 together represent a redundant rebuild on fresh-install boot — schema.sql creates an 8-status table that migration 010 then immediately rebuilds. Decided to update schema.sql anyway because (a) the cost is one-line, (b) schema.sql is the human-readable source of truth for "what does a fresh install look like", and (c) it eliminates the small race window where a fresh install briefly has the 8-status CHECK between `initializeSchema()` and `runFileBasedMigrations()`.

4. **Add a programmatic StuckDetector exemption (modify stuckDetector.ts to check `status !== 'awaiting_input'` explicitly).** Rejected because the exemption is already enforced architecturally — `stmtTransitionToStuck`'s `WHERE status = 'awaiting_review'` clause is the data-layer exemption, and the SQL alone is sufficient. Adding a redundant code-level check would double-encode the invariant and create a maintenance burden if the underlying SQL ever changes.

## Lowest Confidence Area

**The `database.ts` Tier 2 rebuild path retaining the 8-status CHECK constraint post-migration 010.**

Lines 1384–1419 of `main/src/database/database.ts` define a defensive table-rebuild that only triggers when `worktree_path` is declared NOT NULL on an existing install. The rebuild block hard-codes:
- The 8-status CHECK constraint (would downgrade post-010 installs).
- Only 2 of the 3 workflow_runs indexes (`idx_workflow_runs_status_stuck_at` was missed pre-existing).

Migration 010 cannot fix this directly because the Tier 2 rebuild is JS code, not SQL. If a user hits Tier 2 post-010 (extremely unlikely given that 010 fixes the underlying drift), their DB silently regresses from 9-status to 8-status — and the next `awaiting_input` insert from TASK-758's QuestionRouter would throw a CHECK violation, with no obvious error message pointing at Tier 2.

The cost of fixing now is low (4 lines: the CHECK literal + the missing index DDL). The cost of not fixing is a low-probability, high-confusion silent regression. I chose deferral primarily to keep this task's scope minimal and matched to the decomposer's hint surface; a follow-up compound proposal post-merge should land this fix with its own regression test (insert a workflow_run with `worktree_path NOT NULL`, re-initialize, assert the resulting CHECK constraint contains `awaiting_input` and all three indexes exist).

A secondary low-confidence point: my migration 010 test file applies 006+007+010 directly and skips 008/009. This is the same pattern `migration007.test.ts` uses (skips 008/009), and is correct because 008/009 affect unrelated tables. But the fileMigrationRunner has nuanced backfill logic for legacy markers — that's already covered by `fileMigrationRunner.test.ts`. If 010-specific integration with the runner needs verification, it would be a follow-up; the SQL-contract proof in `migration010.test.ts` is sufficient for this task.
