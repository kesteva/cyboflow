/**
 * getExecutionDiffStats (main/src/database/database.ts) is a narrow
 * projection of execution_diffs for stats-only pollers (sessions:get-statistics)
 * — it must return the stats_ and files_changed columns the handler reads
 * WITHOUT the git_diff blob getExecutionDiffs also carries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

let tmpDir: string;
let db: DatabaseService;
let projectId: number;
const sessionId = 'session-1';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-diffstats-'));
  db = new DatabaseService(join(tmpDir, 'test.db'));
  db.initialize();
  projectId = db.createProject('Proj', join(tmpDir, 'repo')).id;
  db.createSession({
    id: sessionId,
    name: 'Session 1',
    initial_prompt: 'do the thing',
    worktree_name: 'wt-1',
    worktree_path: join(tmpDir, 'wt-1'),
    project_id: projectId,
  });
});

afterEach(() => {
  db.getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getExecutionDiffStats', () => {
  it('returns stats + files_changed without the git_diff blob', () => {
    db.createExecutionDiff({
      session_id: sessionId,
      execution_sequence: 1,
      git_diff: 'diff --git a/foo.ts b/foo.ts\n+huge blob content'.repeat(1000),
      files_changed: ['foo.ts', 'bar.ts'],
      stats_additions: 12,
      stats_deletions: 3,
      stats_files_changed: 2,
    });

    const rows = db.getExecutionDiffStats(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      execution_sequence: 1,
      files_changed: ['foo.ts', 'bar.ts'],
      stats_additions: 12,
      stats_deletions: 3,
      stats_files_changed: 2,
      before_commit_hash: null,
      after_commit_hash: null,
    });
    expect(rows[0]).not.toHaveProperty('git_diff');
  });

  it('orders rows by execution_sequence and defaults files_changed to []', () => {
    db.createExecutionDiff({
      session_id: sessionId,
      execution_sequence: 2,
      stats_additions: 5,
      stats_deletions: 1,
      stats_files_changed: 1,
    });
    db.createExecutionDiff({
      session_id: sessionId,
      execution_sequence: 1,
      stats_additions: 1,
      stats_deletions: 0,
      stats_files_changed: 1,
    });

    const rows = db.getExecutionDiffStats(sessionId);
    expect(rows.map(r => r.execution_sequence)).toEqual([1, 2]);
    expect(rows[0].files_changed).toEqual([]);
  });

  it('scopes to the requested session only', () => {
    db.createSession({
      id: 'session-2',
      name: 'Session 2',
      initial_prompt: 'do another thing',
      worktree_name: 'wt-2',
      worktree_path: join(tmpDir, 'wt-2'),
      project_id: projectId,
    });
    db.createExecutionDiff({
      session_id: 'session-2',
      execution_sequence: 1,
      stats_additions: 99,
      stats_deletions: 99,
      stats_files_changed: 99,
    });

    expect(db.getExecutionDiffStats(sessionId)).toEqual([]);
  });

  it('carries before_commit_hash/after_commit_hash through when set (TASK-086)', () => {
    db.createExecutionDiff({
      session_id: sessionId,
      execution_sequence: 1,
      stats_additions: 4,
      stats_deletions: 0,
      stats_files_changed: 1,
      before_commit_hash: 'aaa111',
      after_commit_hash: 'bbb222',
    });

    const rows = db.getExecutionDiffStats(sessionId);
    expect(rows[0].before_commit_hash).toBe('aaa111');
    expect(rows[0].after_commit_hash).toBe('bbb222');
  });
});
