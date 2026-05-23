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
 * Creates a fresh in-memory SQLite database with the full cyboflow schema
 * (workflows, workflow_runs, approvals, raw_events) and FK enforcement ON.
 *
 * Uses GATE_SCHEMA only (in-memory, no file paths).
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(GATE_SCHEMA);
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
  status?: 'queued' | 'starting' | 'running' | 'awaiting_review' | 'stuck' | 'completed' | 'failed' | 'canceled';
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
