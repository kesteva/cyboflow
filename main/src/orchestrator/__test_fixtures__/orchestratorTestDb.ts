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
   * If true, additionally apply migration 010 (questions table + workflow_runs
   * status='awaiting_input'). Implemented as additive SQL on top of
   * GATE_SCHEMA — must NOT mutate GATE_SCHEMA itself or the parity test
   * in __tests__/orchestratorTestDb.test.ts will drift.
   */
  includeQuestionsTable?: boolean;
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
  if (options?.includeStuckDetectedAt) {
    db.exec('ALTER TABLE workflow_runs ADD COLUMN stuck_detected_at INTEGER');
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
  status?: 'queued' | 'starting' | 'running' | 'awaiting_review' | 'awaiting_input' | 'stuck' | 'completed' | 'failed' | 'canceled';
  /** Override the workflow id (defaults to `workflow-${runId}`). */
  workflowId?: string;
  /** Override the project_id FK (defaults to 1). */
  projectId?: number;
  /** Override the workflow name (defaults to 'test-workflow'). */
  workflowName?: string;
  /** Override the worktree_path column (defaults to '/tmp/test'). */
  worktreePath?: string;
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
  const policyJson = overrides?.policyJson ?? '{}';

  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json)
     VALUES (?, ?, ?, '{}')`,
  ).run(workflowId, projectId, workflowName);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(runId, workflowId, projectId, worktreePath, status, policyJson);

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
