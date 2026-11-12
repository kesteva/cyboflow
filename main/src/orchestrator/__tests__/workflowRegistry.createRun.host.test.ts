/**
 * WorkflowRegistry.createRun × environments (M2-C1). A run INHERITS its session's host (sessions.host_id, read in the
 * createRun transaction — never a launch parameter): a remote session's run stamps workflow_runs.host_id and has
 * visual verification + eval forced OFF in the same immutable INSERT; a local session's run (NULL / 'local') stamps
 * NULL and keeps whatever posture it resolved. Runs against the REAL migrated schema (the schema-narrow fixtures with no
 * sessions table are covered by the existing workflowRegistry*.test.ts suites, which read as local).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../../database/database';
import { WorkflowRegistry } from '../workflowRegistry';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';

interface RunRow {
  host_id: string | null;
  verify_enabled: number;
  verify_type: string | null;
  verify_chain: string | null;
  eval_enabled: number | null;
}

describe('WorkflowRegistry.createRun — host stamp (M2-C1)', () => {
  let tmpDir: string;
  let svc: DatabaseService | null = null;

  afterEach(() => {
    svc?.close();
    svc = null;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): { db: Database.Database; registry: WorkflowRegistry; workflowId: string } {
    tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-run-host-'));
    svc = new DatabaseService(join(tmpDir, 'test.db'));
    svc.setMigrationsDirForTesting(join(__dirname, '../../database/migrations'));
    svc.initialize();
    const db = svc.getDb();
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO projects (id, name, path, active) VALUES (7, 'p', '/tmp/p-run-host', 1)").run();
    const insertSession = db.prepare(
      "INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, status, project_id, host_id) VALUES (?, ?, '', ?, ?, 'pending', 7, ?)",
    );
    insertSession.run('s-remote', 's-remote', 's-remote', '/remote/wt', 'h-ssh');
    insertSession.run('s-null', 's-null', 's-null', '/tmp/wt-null', null);
    insertSession.run('s-local', 's-local', 's-local', '/tmp/wt-local', 'local');
    const registry = new WorkflowRegistry(dbAdapter(db), makeSpyLogger());
    const workflowId = registry.ensureQuickWorkflow(7);
    return { db, registry, workflowId };
  }

  const read = (db: Database.Database, runId: string): RunRow =>
    db
      .prepare('SELECT host_id, verify_enabled, verify_type, verify_chain, eval_enabled FROM workflow_runs WHERE id = ?')
      .get(runId) as RunRow;

  const POSTURE_ON = { requestedVerifyEnabled: true, requestedVerifyType: 'static-render-snapshot', requestedEvalEnabled: true } as const;

  it('a remote session’s run stamps host_id and forces verification + eval off', () => {
    const { db, registry, workflowId } = setup();
    const { runId } = registry.createRun(workflowId, 'sdk', 's-remote', undefined, POSTURE_ON);
    expect(read(db, runId)).toEqual({
      host_id: 'h-ssh', verify_enabled: 0, verify_type: null, verify_chain: null, eval_enabled: 0,
    });
  });

  it("a local session’s run (NULL or legacy 'local') stamps NULL and keeps its resolved posture", () => {
    const { db, registry, workflowId } = setup();
    for (const sessionId of ['s-null', 's-local']) {
      const { runId } = registry.createRun(workflowId, 'sdk', sessionId, undefined, POSTURE_ON);
      const row = read(db, runId);
      expect(row.host_id).toBeNull();
      expect(row.verify_enabled).toBe(1);
      expect(row.verify_type).toBe('static-render-snapshot');
      expect(row.verify_chain).not.toBeNull();
      expect(row.eval_enabled).toBe(1);
    }
  });

  it('a session id with no row reads as local', () => {
    const { db, registry, workflowId } = setup();
    const { runId } = registry.createRun(workflowId, 'sdk', 's-missing');
    expect(read(db, runId).host_id).toBeNull();
  });
});
