/**
 * Behavioral tests for the folder-hierarchy CRUD on DatabaseService
 * (main/src/database/database.ts): wouldCreateCircularReference,
 * getFolderDepth, deleteFolder (ON DELETE SET NULL on sessions), and
 * reorderFolders (id + project_id scoping).
 *
 * Uses a REAL DatabaseService against a temp-file DB and a full initialize()
 * so the folders table (created + ALTER-ed to add parent_folder_id during
 * initialize) and the sessions FK (folder_id ON DELETE SET NULL) are exactly
 * as they ship. Direct getDb() inserts are used only to craft a PATHOLOGICAL
 * pre-existing cycle that createFolder()'s depth guard would otherwise refuse.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

let tmpDir: string;
let db: DatabaseService;
let projectId: number;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-folders-'));
  db = new DatabaseService(join(tmpDir, 'test.db'));
  db.initialize();
  projectId = db.createProject('Proj', join(tmpDir, 'repo')).id;
});

afterEach(() => {
  db.getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert a folder row directly, bypassing createFolder()'s depth/parent guards. */
function rawFolder(id: string, parentId: string | null, pid = projectId): void {
  db.getDb()
    .prepare(
      'INSERT INTO folders (id, name, project_id, parent_folder_id, display_order) VALUES (?, ?, ?, ?, 0)',
    )
    .run(id, id, pid, parentId);
}

/**
 * Craft an illegal multi-row parent cycle by toggling FK enforcement off for
 * the inserts (a forward reference to a not-yet-inserted parent would otherwise
 * violate the folders(id) FK). Restores the pragma afterward.
 */
function rawCycle(rows: Array<[id: string, parentId: string]>): void {
  const raw = db.getDb();
  raw.pragma('foreign_keys = OFF');
  try {
    for (const [id, parentId] of rows) rawFolder(id, parentId);
  } finally {
    raw.pragma('foreign_keys = ON');
  }
}

describe('wouldCreateCircularReference', () => {
  it('is true when the proposed parent IS the folder being moved (self-parent)', () => {
    rawFolder('a', null);
    expect(db.wouldCreateCircularReference('a', 'a')).toBe(true);
  });

  it('is true when moving a folder into its own descendant', () => {
    // a -> b -> c chain. Moving `a` under `c` would make `a` its own descendant.
    rawFolder('a', null);
    rawFolder('b', 'a');
    rawFolder('c', 'b');
    expect(db.wouldCreateCircularReference('a', 'c')).toBe(true);
  });

  it('is false for a legitimate move into an unrelated subtree', () => {
    rawFolder('a', null);
    rawFolder('b', 'a');
    rawFolder('x', null); // unrelated root
    expect(db.wouldCreateCircularReference('x', 'b')).toBe(false);
  });

  it('short-circuits to true on a pre-existing data cycle instead of looping forever', () => {
    // Craft an illegal cycle p -> q -> p directly.
    rawCycle([
      ['p', 'q'],
      ['q', 'p'],
    ]);
    expect(db.wouldCreateCircularReference('zzz', 'p')).toBe(true);
  });
});

describe('getFolderDepth', () => {
  it('returns 2 for a 3-level chain (root is depth 0)', () => {
    rawFolder('root', null);
    rawFolder('mid', 'root');
    rawFolder('leaf', 'mid');
    expect(db.getFolderDepth('leaf')).toBe(0 + 2);
    expect(db.getFolderDepth('mid')).toBe(1);
    expect(db.getFolderDepth('root')).toBe(0);
  });

  it('bails past depth 10 on a pathological cycle rather than hanging', () => {
    rawCycle([
      ['c1', 'c2'],
      ['c2', 'c1'],
    ]);
    const depth = db.getFolderDepth('c1');
    // The safety guard stops the walk; the exact value is unimportant, only
    // that it terminates above the guard threshold.
    expect(depth).toBeGreaterThan(10);
  });
});

describe('deleteFolder', () => {
  it('nulls out folder_id on child sessions via ON DELETE SET NULL', () => {
    const folder = db.createFolder('Bucket', projectId);
    db.createSession({
      id: 'sess-1',
      name: 'S',
      initial_prompt: 'p',
      worktree_name: 'w',
      worktree_path: join(tmpDir, 'w'),
      project_id: projectId,
      folder_id: folder.id,
    });

    // Precondition: the session is in the folder.
    expect(db.getSession('sess-1')?.folder_id).toBe(folder.id);

    db.deleteFolder(folder.id);

    expect(db.getFolder(folder.id)).toBeUndefined();
    // Session survives, but its folder_id is cleared.
    const session = db.getSession('sess-1');
    expect(session).toBeDefined();
    expect(session?.folder_id ?? null).toBeNull();
  });
});

describe('reorderFolders', () => {
  it('matches BOTH id and project_id so cross-project rows are never touched', () => {
    const otherProjectId = db.createProject('Other', join(tmpDir, 'repo2')).id;
    const mine = db.createFolder('Mine', projectId);
    const theirs = db.createFolder('Theirs', otherProjectId);

    // Ask to reorder within `projectId`, but include a folder from the OTHER
    // project. Its project_id won't match, so the UPDATE must skip it.
    db.reorderFolders(projectId, [
      { id: mine.id, displayOrder: 7 },
      { id: theirs.id, displayOrder: 99 },
    ]);

    expect(db.getFolder(mine.id)?.display_order).toBe(7);
    // The cross-project folder keeps its original order (0), not 99.
    expect(db.getFolder(theirs.id)?.display_order).toBe(0);
  });
});
