/**
 * sessions.updated_at doubles as the session's last-ACTIVITY clock: the
 * quick-sessions board derives its "quiet for N" label from it
 * (quickSessionListing.ts idleSince), and the sidebar's relative time reads it
 * as lastActivity. These tests pin the rule that presentation-only writes must
 * NOT bump it — the regression they guard: a sidebar drag (reorderSessions)
 * rewrote display_order + updated_at for EVERY session in one transaction,
 * stamping the whole project with a single identical timestamp and collapsing
 * every idle row's "quiet" label to the same value; and merely opening a
 * session (markSessionAsViewed) reset its idle clock.
 *
 * Uses a REAL DatabaseService against a temp-file DB (folderCrud.test.ts
 * pattern). updated_at is seeded to a fixed past value via raw SQL so a
 * spurious CURRENT_TIMESTAMP bump is detectable regardless of test speed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const SEEDED_UPDATED_AT = '2026-01-01 00:00:00';

let tmpDir: string;
let db: DatabaseService;
let projectId: number;

function createSession(id: string): void {
  db.createSession({
    id,
    name: id,
    initial_prompt: 'p',
    worktree_name: `w-${id}`,
    worktree_path: join(tmpDir, `w-${id}`),
    project_id: projectId,
  });
  // Pin updated_at to a known past instant so any CURRENT_TIMESTAMP bump shows.
  db.getDb()
    .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
    .run(SEEDED_UPDATED_AT, id);
}

function updatedAt(id: string): string {
  return (
    db.getDb().prepare('SELECT updated_at FROM sessions WHERE id = ?').get(id) as {
      updated_at: string;
    }
  ).updated_at;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-updatedat-'));
  db = new DatabaseService(join(tmpDir, 'test.db'));
  db.initialize();
  projectId = db.createProject('Proj', join(tmpDir, 'repo')).id;
});

afterEach(() => {
  db.getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('presentation-only writes do not bump sessions.updated_at', () => {
  it('reorderSessions rewrites display_order without touching updated_at', () => {
    createSession('s1');
    createSession('s2');
    createSession('s3');

    db.reorderSessions([
      { id: 's1', displayOrder: 2 },
      { id: 's2', displayOrder: 0 },
      { id: 's3', displayOrder: 1 },
    ]);

    for (const id of ['s1', 's2', 's3']) {
      expect(updatedAt(id)).toBe(SEEDED_UPDATED_AT);
    }
    const order = db
      .getDb()
      .prepare('SELECT id FROM sessions ORDER BY display_order ASC')
      .all() as Array<{ id: string }>;
    expect(order.map((r) => r.id)).toEqual(['s2', 's3', 's1']);
  });

  it('updateSessionDisplayOrder does not touch updated_at', () => {
    createSession('s1');
    db.updateSessionDisplayOrder('s1', 7);
    expect(updatedAt('s1')).toBe(SEEDED_UPDATED_AT);
  });

  it('markSessionAsViewed stamps last_viewed_at only and still reads as viewed', () => {
    createSession('s1');
    db.markSessionAsViewed('s1');

    expect(updatedAt('s1')).toBe(SEEDED_UPDATED_AT);
    const row = db
      .getDb()
      .prepare(
        `SELECT last_viewed_at,
                CASE WHEN last_viewed_at IS NULL OR datetime(last_viewed_at) < datetime(updated_at)
                     THEN 1 ELSE 0 END AS unviewed
           FROM sessions WHERE id = ?`,
      )
      .get('s1') as { last_viewed_at: string | null; unviewed: number };
    expect(row.last_viewed_at).not.toBeNull();
    // The board's unviewed predicate (quickSessionListing SELECT_COLS) must
    // read viewed once last_viewed_at is stamped, even without an updated_at bump.
    expect(row.unviewed).toBe(0);
  });

  it('updateSession with only folder_id does not touch updated_at', () => {
    createSession('s1');
    const folder = db.createFolder('Bucket', projectId);
    db.updateSession('s1', { folder_id: folder.id });
    expect(updatedAt('s1')).toBe(SEEDED_UPDATED_AT);
  });

  it('updateSession with a status change DOES bump updated_at (activity clock)', () => {
    createSession('s1');
    db.updateSession('s1', { status: 'running' });
    expect(updatedAt('s1')).not.toBe(SEEDED_UPDATED_AT);
  });
});
