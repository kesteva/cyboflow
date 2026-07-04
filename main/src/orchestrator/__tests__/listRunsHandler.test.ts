/**
 * Unit tests for listRunsHandler.
 *
 * Four behaviors tested per the test_strategy in the TASK-710 plan:
 *   (a) Empty result for a project with no workflow_runs rows.
 *   (b) Rows ordered newest-first (DESC by created_at).
 *   (c) projectId scoping — runs from another project are excluded.
 *   (d) Returned rows omit policy_json even when the underlying DB row has one.
 *
 * Uses an in-memory better-sqlite3 DB seeded with the GATE_SCHEMA fixture
 * (migration 006 equivalent) via orchestratorTestDb.createTestDb().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { listRunsHandler } from '../runQueries';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seeds a workflow + workflow_run row for a given project with an explicit
 * created_at timestamp so we can control ordering.
 */
function seedRunAt(
  db: Database.Database,
  runId: string,
  projectId: number,
  createdAt: string,
): void {
  const workflowId = `workflow-for-${runId}`;

  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json)
     VALUES (?, ?, 'test-workflow', '{}')`,
  ).run(workflowId, projectId);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json, created_at, updated_at)
     VALUES (?, ?, ?, '/tmp/test', 'running', '{"key":"val"}', ?, ?)`,
  ).run(runId, workflowId, projectId, createdAt, createdAt);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('listRunsHandler', () => {
  let db: Database.Database;

  beforeEach(() => {
    // listRunsHandler's SELECT projects `substrate` (migration 013), which
    // GATE_SCHEMA omits — layer it additively via the shared fixture flag.
    db = createTestDb({ includeSubstrate: true });
  });

  // -------------------------------------------------------------------------
  // (a) Empty result for a project with no runs
  // -------------------------------------------------------------------------
  it('returns [] when the project has no workflow_runs rows', () => {
    const adapter = dbAdapter(db);
    const result = listRunsHandler(adapter, 1);
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // (b) Two rows for project 1 with ~100ms-apart timestamps return newest-first
  // -------------------------------------------------------------------------
  it('returns rows ordered newest-first (DESC by created_at)', () => {
    const olderAt = '2026-05-23T10:00:00.000Z';
    const newerAt = '2026-05-23T10:00:00.100Z';

    seedRunAt(db, 'run-older', 1, olderAt);
    seedRunAt(db, 'run-newer', 1, newerAt);

    const adapter = dbAdapter(db);
    const result = listRunsHandler(adapter, 1);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('run-newer');
    expect(result[1].id).toBe('run-older');
  });

  // -------------------------------------------------------------------------
  // (c) Rows scoped by projectId — runs for project 2 excluded when querying 1
  // -------------------------------------------------------------------------
  it('excludes runs from other projects', () => {
    // Project 1 run.
    seedRun(db, { id: 'run-p1', projectId: 1 });
    // Project 2 run — must NOT appear in project 1 query.
    seedRun(db, { id: 'run-p2', projectId: 2 });

    const adapter = dbAdapter(db);

    const p1Results = listRunsHandler(adapter, 1);
    expect(p1Results).toHaveLength(1);
    expect(p1Results[0].id).toBe('run-p1');

    const p2Results = listRunsHandler(adapter, 2);
    expect(p2Results).toHaveLength(1);
    expect(p2Results[0].id).toBe('run-p2');
  });

  // -------------------------------------------------------------------------
  // (d) Returned rows omit policy_json even when the underlying row has one
  // -------------------------------------------------------------------------
  it('does not include policy_json in returned rows', () => {
    // seedRun inserts policy_json = '{}' by default.
    seedRun(db, { id: 'run-policy', projectId: 1, policyJson: '{"allow":["bash"]}' });

    const adapter = dbAdapter(db);
    const result = listRunsHandler(adapter, 1);

    expect(result).toHaveLength(1);
    // policy_json must not be present on any returned row.
    expect(Object.keys(result[0])).not.toContain('policy_json');
  });
});

// ---------------------------------------------------------------------------
// (e) substrate round-trip — the IDEA-013 / IDEA-030 data plumb.
//
// GATE_SCHEMA (the parity-pinned base) does NOT carry the substrate column;
// migration 013 adds it on the live DB. So this block layers migration 013's
// column additively via the shared fixture's includeSubstrate flag (orthogonal
// to the other migration flags) — it does NOT widen GATE_SCHEMA, so the
// GATE_SCHEMA parity test stays byte-identical.
// ---------------------------------------------------------------------------

/**
 * Seeds a workflow + workflow_run row with an explicit substrate value. The
 * shared seedRun omits the substrate column (the legacy path), so this local
 * helper exists to drive the interactive case.
 */
function seedRunWithSubstrate(
  db: Database.Database,
  runId: string,
  projectId: number,
  substrate: 'sdk' | 'interactive',
): void {
  const workflowId = `workflow-for-${runId}`;

  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json)
     VALUES (?, ?, 'test-workflow', '{}')`,
  ).run(workflowId, projectId);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json, substrate)
     VALUES (?, ?, ?, '/tmp/test', 'running', '{}', ?)`,
  ).run(runId, workflowId, projectId, substrate);
}

describe('listRunsHandler substrate round-trip', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Migration 013's substrate column, layered additively via the shared
    // fixture flag (NOT a GATE_SCHEMA / shared-fixture mutation).
    db = createTestDb({ includeSubstrate: true });
  });

  // (a) A run seeded with substrate='interactive' surfaces 'interactive'.
  it("surfaces substrate==='interactive' for an interactive-seeded run", () => {
    seedRunWithSubstrate(db, 'run-interactive', 1, 'interactive');

    const adapter = dbAdapter(db);
    const result = listRunsHandler(adapter, 1);

    expect(result).toHaveLength(1);
    expect(result[0].substrate).toBe('interactive');
  });

  // (b) A run inserted WITHOUT a substrate value (the shared seedRun, which
  //     omits the column) reads back 'sdk' from migration-013's NOT NULL DEFAULT.
  it("reads back substrate==='sdk' for a legacy/default run", () => {
    seedRun(db, { id: 'run-legacy', projectId: 1 });

    const adapter = dbAdapter(db);
    const result = listRunsHandler(adapter, 1);

    expect(result).toHaveLength(1);
    expect(result[0].substrate).toBe('sdk');
  });
});

// ---------------------------------------------------------------------------
// (f) variant_label projection (migration 046 / A/B testing).
//
// includeSubstrate folds in the four workflow_runs A/B tagging columns
// (addVariantColumnsOnce in orchestratorTestDb.ts), so the same fixture flag
// this suite already opts into covers variant_label — no new fixture flag
// needed. Surfaced on the list row so the left-rail run chip can render
// "Variant: <label>" without a second query (WorkflowRunListRow.variant_label).
// ---------------------------------------------------------------------------

function seedRunWithVariantLabel(
  db: Database.Database,
  runId: string,
  projectId: number,
  variantLabel: string | null,
): void {
  const workflowId = `workflow-for-${runId}`;

  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json)
     VALUES (?, ?, 'test-workflow', '{}')`,
  ).run(workflowId, projectId);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json, variant_label)
     VALUES (?, ?, ?, '/tmp/test', 'running', '{}', ?)`,
  ).run(runId, workflowId, projectId, variantLabel);
}

describe('listRunsHandler variant_label projection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb({ includeSubstrate: true });
  });

  it('surfaces the denormalized variant_label for a variant-tagged run', () => {
    seedRunWithVariantLabel(db, 'run-variant', 1, 'Variant B');

    const adapter = dbAdapter(db);
    const result = listRunsHandler(adapter, 1);

    expect(result).toHaveLength(1);
    expect(result[0].variant_label).toBe('Variant B');
  });

  it('reads back variant_label as null for a baseline (non-variant) run', () => {
    seedRun(db, { id: 'run-baseline', projectId: 1 });

    const adapter = dbAdapter(db);
    const result = listRunsHandler(adapter, 1);

    expect(result).toHaveLength(1);
    expect(result[0].variant_label).toBeNull();
  });
});
