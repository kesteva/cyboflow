/**
 * Shared test-database helpers for orchestrator unit tests.
 *
 * All helpers use GATE_SCHEMA (in-memory, no file I/O). The parity test in
 * __tests__/orchestratorTestDb.test.ts pins GATE_SCHEMA against the canonical
 * migration file to catch any column-level drift.
 *
 * NOTE: PRAGMA table_info() used in the parity test does NOT report CHECK
 * constraints, so a CHECK-only drift (e.g. adding a new enum value to a
 * status column) would not fail that test. Column additions, renames, and
 * removals ARE caught.
 */
import Database from 'better-sqlite3';
import { GATE_SCHEMA } from '../../database/__test_fixtures__/registrySchema';

/**
 * Options for createTestDb. All fields are optional; defaults preserve the
 * previous zero-arg behavior (FK ON, GATE_SCHEMA only).
 *
 * Important: the options layer additional SQL ON TOP of GATE_SCHEMA — they do
 * NOT fold into GATE_SCHEMA itself. The GATE_SCHEMA parity test in
 * __tests__/orchestratorTestDb.test.ts compares GATE_SCHEMA against
 * 006_cyboflow_schema.sql using a no-options call; adding options must not
 * widen GATE_SCHEMA or that parity test would drift.
 */
export interface CreateTestDbOptions {
  /**
   * If true, FK enforcement is disabled (PRAGMA foreign_keys=OFF).
   * Defaults to false (FK ON).
   */
  disableForeignKeys?: boolean;
  /**
   * If true, additionally apply migration 007's ALTER statement, which adds
   * stuck_detected_at INTEGER to workflow_runs. Defaults to false.
   *
   * NOTE: The ALTER statement does NOT use IF NOT EXISTS (SQLite ALTER does
   * not support that clause). Do not pass this option twice on the same DB.
   */
  includeStuckDetectedAt?: boolean;
  /**
   * If true, layer migration 013's `substrate` column (NOT NULL DEFAULT 'sdk')
   * onto workflow_runs as an additive ALTER (NOT a GATE_SCHEMA mutation).
   * Defaults to false.
   *
   * `listRunsHandler`'s SELECT projects `substrate` (IDEA-013 / IDEA-030 data
   * plumb), so every test that exercises that handler — listRunsHandler.test.ts
   * and `cyboflow.runs.list` in runs.test.ts — opts in via this flag. Orthogonal
   * to the other flags (it composes with includeStuckDetectedAt — they add
   * distinct columns), and never widens GATE_SCHEMA, so the parity test
   * (no-options createTestDb()) is unaffected.
   *
   * NOTE: SQLite ALTER has no IF NOT EXISTS — do not pass this option twice on
   * the same DB.
   */
  includeSubstrate?: boolean;
  /**
   * If true, additionally apply migration 010 (questions table + workflow_runs
   * status='awaiting_input'). Implemented as additive SQL on top of
   * GATE_SCHEMA — must NOT mutate GATE_SCHEMA itself or the parity test
   * in __tests__/orchestratorTestDb.test.ts will drift.
   *
   * THIS IS THE SINGLE SOURCE OF TRUTH for the post-migration-010 workflow_runs
   * 9-status CHECK constraint in tests. Do NOT inline the rebuild SQL elsewhere
   * — tests that need awaiting_input acceptance must opt in via this flag so
   * a future CHECK widening only has to update the canonical migration file.
   */
  includeQuestionsTable?: boolean;
  /**
   * If true, additionally layer migration 011's `current_step_id` column and
   * migration 014's run->task link columns (task_id, outcome, base_branch,
   * base_sha, steps_snapshot_json) onto workflow_runs. Additive SQL on top of
   * GATE_SCHEMA — must NOT mutate GATE_SCHEMA itself or the parity test in
   * __tests__/orchestratorTestDb.test.ts will drift.
   *
   * Tests that exercise getRunById (which SELECTs all of these columns) opt in
   * via this flag. The ALTER statements do NOT use IF NOT EXISTS; do not pass
   * this option twice on the same DB.
   */
  includeWorkflowRunTaskColumns?: boolean;
}

/**
 * Creates a fresh in-memory SQLite database with the full cyboflow schema
 * (workflows, workflow_runs, approvals, raw_events) and FK enforcement ON
 * by default.
 *
 * Pass options to relax FK enforcement or to layer additional migration SQL
 * (e.g. migration 007's stuck_detected_at column) on top of GATE_SCHEMA.
 * The GATE_SCHEMA itself is always applied unchanged regardless of options —
 * only the post-exec steps differ.
 */
export function createTestDb(options?: CreateTestDbOptions): Database.Database {
  const db = new Database(':memory:');
  db.pragma(options?.disableForeignKeys ? 'foreign_keys = OFF' : 'foreign_keys = ON');
  db.exec(GATE_SCHEMA);
  // Migration 022 (sprint lanes): batch_id is projected by BOTH read-model
  // surfaces (listRunsHandler/runs.list via includeSubstrate) AND the row-level
  // readers (getRunById / cancelRunHandler via includeWorkflowRunTaskColumns).
  // Idempotent add so passing both flags never double-ALTERs.
  let batchIdAdded = false;
  const addBatchIdColumnOnce = (): void => {
    if (batchIdAdded) return;
    db.exec('ALTER TABLE workflow_runs ADD COLUMN batch_id TEXT');
    batchIdAdded = true;
  };
  // Migration 031 (execution model): getRunById projects execution_model right
  // beside substrate, and createRun stamps it. Both read-model surfaces
  // (includeSubstrate) and the row-level readers (includeWorkflowRunTaskColumns)
  // therefore need the column — folded in idempotently exactly like batch_id so
  // passing both flags never double-ALTERs. Additive — never widens GATE_SCHEMA.
  let executionModelAdded = false;
  const addExecutionModelColumnOnce = (): void => {
    if (executionModelAdded) return;
    db.exec(
      "ALTER TABLE workflow_runs ADD COLUMN execution_model TEXT NOT NULL DEFAULT 'orchestrated' CHECK (execution_model IN ('orchestrated','programmatic'))",
    );
    executionModelAdded = true;
  };
  // Migration 037 (per-run model pin): getRunById projects model right beside
  // execution_model, and createRun stamps it. Both read-model surfaces
  // (includeSubstrate) and the row-level readers (includeWorkflowRunTaskColumns)
  // therefore need the column — folded in idempotently exactly like
  // execution_model so passing both flags never double-ALTERs. Plain nullable TEXT
  // (no CHECK); additive — never widens GATE_SCHEMA.
  let modelAdded = false;
  const addModelColumnOnce = (): void => {
    if (modelAdded) return;
    db.exec('ALTER TABLE workflow_runs ADD COLUMN model TEXT');
    modelAdded = true;
  };
  // Migration 044 (per-run code-review-eval override): getRunById projects
  // eval_enabled right beside model, and createRun stamps it. Both read-model
  // surfaces (includeSubstrate) and the row-level readers
  // (includeWorkflowRunTaskColumns) therefore need the column — folded in
  // idempotently exactly like model so passing both flags never double-ALTERs.
  // Plain nullable INTEGER (0/1/NULL, no CHECK); additive — never widens
  // GATE_SCHEMA.
  let evalEnabledAdded = false;
  const addEvalEnabledColumnOnce = (): void => {
    if (evalEnabledAdded) return;
    db.exec('ALTER TABLE workflow_runs ADD COLUMN eval_enabled INTEGER');
    evalEnabledAdded = true;
  };
  // Migration 046 (A/B testing): createRun stamps + getRunById projects four new
  // workflow_runs tagging columns (experiment_id / experiment_arm / variant_id /
  // variant_label). Both read-model surfaces (includeSubstrate) and the row-level
  // readers (includeWorkflowRunTaskColumns) therefore need them — folded in
  // idempotently exactly like model/eval_enabled so passing both flags never
  // double-ALTERs. Plain nullable TEXT (no CHECK); additive — never widens
  // GATE_SCHEMA.
  let variantColumnsAdded = false;
  const addVariantColumnsOnce = (): void => {
    if (variantColumnsAdded) return;
    db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_id TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_arm TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN variant_id TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN variant_label TEXT');
    variantColumnsAdded = true;
  };
  if (options?.includeStuckDetectedAt) {
    db.exec('ALTER TABLE workflow_runs ADD COLUMN stuck_detected_at INTEGER');
  }
  if (options?.includeSubstrate) {
    // Migration 013: surfaced by listRunsHandler's SELECT (substrate projection).
    // Additive — never widens GATE_SCHEMA, so the parity test (no-options call)
    // is unaffected. Orthogonal to includeStuckDetectedAt (distinct column).
    db.exec(
      "ALTER TABLE workflow_runs ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk' CHECK (substrate IN ('sdk','interactive'))",
    );
    // Migration 019 (session<->run restructure): listRunsHandler's SELECT also
    // projects session_id, which travels with the same read-model surface as
    // substrate. Folded in here so every includeSubstrate consumer (listRunsHandler
    // + runs.list) resolves the column. Additive — never widens GATE_SCHEMA.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
    // Migration 022 (sprint lanes): listRunsHandler's SELECT also projects
    // batch_id (the swimlane-canvas switch keys off it). Same read-model
    // surface, same opt-in flag. Additive — never widens GATE_SCHEMA.
    addBatchIdColumnOnce();
    // Migration 031: getRunById projects execution_model beside substrate.
    addExecutionModelColumnOnce();
    // Migration 037: getRunById projects model beside execution_model.
    addModelColumnOnce();
    // Migration 044: getRunById projects eval_enabled beside model.
    addEvalEnabledColumnOnce();
    // Migration 046: getRunById projects the four A/B tagging columns.
    addVariantColumnsOnce();
  }
  if (options?.includeQuestionsTable) {
    // Migration 010 references stuck_detected_at (added in migration 007) in the
    // workflow_runs reconstruction SELECT. Apply it first if not already present.
    if (!options?.includeStuckDetectedAt) {
      db.exec('ALTER TABLE workflow_runs ADD COLUMN stuck_detected_at INTEGER');
    }
    // Read and apply migration 010 verbatim — single source of truth for the
    // questions schema and the workflow_runs CHECK-constraint recreate.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('path');
    const migration010Path = path.resolve(__dirname, '../../database/migrations/010_questions.sql');
    const sql = fs.readFileSync(migration010Path, 'utf8');
    db.exec(sql);
  }
  if (options?.includeWorkflowRunTaskColumns) {
    // Mirror migration 011 (current_step_id) + migration 014's workflow_runs
    // ALTERs. Inlined here (rather than reading the files) so this layering is
    // resilient to migration 010's table-recreation recipe ordering.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN task_id TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN outcome TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN base_branch TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN base_sha TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN steps_snapshot_json TEXT');
    // Migration 017: planner pre-launch seed-idea link.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_idea_id TEXT');
    // Migration 018: idle-chat nudge SDK conversation id.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN claude_session_id TEXT');
    // Migration 022 (sprint lanes): getRunById + cancelRunHandler project batch_id.
    addBatchIdColumnOnce();
    // Migration 031: getRunById projects execution_model (sibling immutable stamp
    // to substrate). Folded in so row-level readers resolve the column.
    addExecutionModelColumnOnce();
    // Migration 037: getRunById projects model (sibling immutable stamp to
    // execution_model). Folded in so row-level readers resolve the column.
    addModelColumnOnce();
    // Migration 044: getRunById projects eval_enabled (per-run eval override).
    addEvalEnabledColumnOnce();
    // Migration 046: getRunById projects the four A/B tagging columns.
    addVariantColumnsOnce();
  }
  return db;
}

/**
 * Optional overrides for seedRun. All fields are optional; defaults are chosen
 * to be valid for FK constraints without colliding across concurrent seeds.
 */
export interface SeedRunOverrides {
  /** Override the workflow_run id (defaults to a generated uuid-like string). */
  id?: string;
  /** Override the run status (defaults to 'running'). */
  status?: 'queued' | 'starting' | 'running' | 'awaiting_review' | 'awaiting_input' | 'stuck' | 'completed' | 'failed' | 'canceled' | 'paused';
  /** Override the workflow id (defaults to `workflow-${runId}`). */
  workflowId?: string;
  /** Override the project_id FK (defaults to 1). */
  projectId?: number;
  /** Override the workflow name (defaults to 'test-workflow'). */
  workflowName?: string;
  /** Override the worktree_path column (defaults to '/tmp/test'). */
  worktreePath?: string;
  /** Override the branch_name column (defaults to NULL). */
  branchName?: string;
  /** Override the base_sha column (defaults to NULL — not yet launched). */
  baseSha?: string;
  /** Override the policy_json column (defaults to '{}'). */
  policyJson?: string;
}

/**
 * Seeds a workflow + workflow_run row pair with sensible defaults and optional
 * overrides. The workflow row is inserted with INSERT OR IGNORE so callers can
 * share a single workflow across multiple runs.
 *
 * @returns { workflowId, runId } — the IDs of the inserted rows.
 */
export function seedRun(db: Database.Database, overrides?: SeedRunOverrides): { workflowId: string; runId: string } {
  const runId = overrides?.id ?? `run-${Math.random().toString(36).slice(2)}`;
  const workflowId = overrides?.workflowId ?? `workflow-${runId}`;
  const status = overrides?.status ?? 'running';
  const projectId = overrides?.projectId ?? 1;
  const workflowName = overrides?.workflowName ?? 'test-workflow';
  const worktreePath = overrides?.worktreePath ?? '/tmp/test';
  const branchName = overrides?.branchName ?? null;
  const policyJson = overrides?.policyJson ?? '{}';

  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json)
     VALUES (?, ?, ?, '{}')`,
  ).run(workflowId, projectId, workflowName);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, branch_name, status, policy_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, workflowId, projectId, worktreePath, branchName, status, policyJson);

  // base_sha lives only on DBs created with includeWorkflowRunTaskColumns (it is a
  // migration-014 column, not part of GATE_SCHEMA). Set it as a follow-up UPDATE
  // only when the caller asked for it, so the default base schema is untouched.
  if (overrides?.baseSha !== undefined) {
    db.prepare('UPDATE workflow_runs SET base_sha = ? WHERE id = ?').run(overrides.baseSha, runId);
  }

  return { workflowId, runId };
}

/**
 * Optional overrides for seedApproval. `runId` is required (no phantom rows).
 * All other fields are optional; defaults produce a minimal valid pending row.
 */
export interface SeedApprovalOverrides {
  /** The approval id. Defaults to a generated unique string. */
  id?: string;
  /** The workflow_run id this approval belongs to (required). */
  runId: string;
  /** The tool name. Defaults to 'bash'. */
  toolName?: string;
  /** The tool input JSON string. Defaults to '{}'. */
  toolInputJson?: string;
  /** The tool_use_id. Defaults to the approval id. */
  toolUseId?: string;
  /** The approval status. Defaults to 'pending'. */
  status?: 'pending' | 'approved' | 'rejected' | 'timed_out';
  /** The created_at ISO string. Defaults to the current time. */
  createdAt?: string;
}

/**
 * Seeds one approvals row with sensible defaults and optional overrides.
 *
 * The caller must have already called `seedRun(db, { id: runId })` (or
 * equivalent) before this function — `runId` is a NOT NULL FK and inserting
 * without a parent row will fail the FK constraint.
 *
 * @returns The inserted approval id.
 */
export function seedApproval(db: Database.Database, overrides: SeedApprovalOverrides): string {
  const id = overrides.id ?? `approval-${Math.random().toString(36).slice(2)}`;
  const toolName = overrides.toolName ?? 'bash';
  const toolInputJson = overrides.toolInputJson ?? '{}';
  const toolUseId = overrides.toolUseId ?? id;
  const status = overrides.status ?? 'pending';
  const createdAt = overrides.createdAt ?? new Date().toISOString();

  db.prepare(
    `INSERT INTO approvals
       (id, run_id, tool_name, tool_input_json, tool_use_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, overrides.runId, toolName, toolInputJson, toolUseId, status, createdAt);

  return id;
}

/**
 * Optional overrides for seedQuestion. `runId` is required (no phantom rows).
 * All other fields are optional; defaults produce a minimal valid pending row.
 *
 * Requires the test DB to have been created with `includeQuestionsTable: true`.
 */
export interface SeedQuestionOverrides {
  /** The question id. Defaults to a generated unique string. */
  id?: string;
  /** The workflow_run id this question belongs to (required). */
  runId: string;
  /** The tool_use_id. Defaults to the question id. */
  toolUseId?: string;
  /** The questions_json. Defaults to '[]'. */
  questionsJson?: string;
  /** The question status. Defaults to 'pending'. */
  status?: 'pending' | 'answered' | 'timed_out';
  /** The created_at ISO string. Defaults to the current time. */
  createdAt?: string;
}

/**
 * Seeds one questions row with sensible defaults and optional overrides.
 *
 * The caller must have already called `seedRun(db, { id: runId })` (or
 * equivalent) before this function — `runId` is a NOT NULL FK and inserting
 * without a parent row will fail the FK constraint.
 *
 * @returns The inserted question id.
 */
export function seedQuestion(db: Database.Database, overrides: SeedQuestionOverrides): string {
  const id = overrides.id ?? `question-${Math.random().toString(36).slice(2)}`;
  const toolUseId = overrides.toolUseId ?? id;
  const questionsJson = overrides.questionsJson ?? '[]';
  const status = overrides.status ?? 'pending';
  const createdAt = overrides.createdAt ?? new Date().toISOString();

  db.prepare(
    `INSERT INTO questions
       (id, run_id, tool_use_id, questions_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, overrides.runId, toolUseId, questionsJson, status, createdAt);

  return id;
}
