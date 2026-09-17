/**
 * Integration tests for cyboflow.design.forEntity + .snapshotHtml — the READ side
 * of approved designs, which is what lets a task/epic card anywhere in the backlog
 * open the design its work is supposed to match.
 *
 * Wires the live router through appRouter.createCaller against a hand-rolled DB
 * (ideas/epics/tasks/approved_designs only — these procedures touch nothing else).
 * The snapshot tree is a real temp dir, because the containment check these tests
 * exercise is about resolved filesystem paths, and faking it would test nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { DesignHandoffService } from '../../../design/designHandoffService';

const SNAPSHOT_HTML = '<!doctype html><html><body><h1>the approved design</h1></body></html>';

let snapDir: string | null = null;
let outsideDir: string | null = null;

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ideas (id TEXT PRIMARY KEY, ref TEXT, title TEXT);
    CREATE TABLE epics (id TEXT PRIMARY KEY, originating_idea_id TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      originating_idea_id TEXT,
      parent_epic_id TEXT
    );
    CREATE TABLE approved_designs (
      id TEXT PRIMARY KEY,
      idea_id TEXT NOT NULL,
      project_id INTEGER NOT NULL DEFAULT 1,
      handoff_id TEXT,
      session_id TEXT,
      draft_revision INTEGER NOT NULL DEFAULT 0,
      prototype_artifact_id TEXT NOT NULL,
      prototype_revision INTEGER NOT NULL,
      snapshot_path TEXT NOT NULL,
      approved_at DATETIME,
      superseded_at DATETIME,
      source TEXT NOT NULL DEFAULT 'design-mode',
      source_run_id TEXT
    );
  `);
  return db;
}

/** A real snapshot tree + the boot wiring the containment check reads its root from. */
function wireSnapshotDir(db: Database.Database): string {
  snapDir = mkdtempSync(join(tmpdir(), 'cyboflow-designsnap-'));
  DesignHandoffService._resetForTesting();
  DesignHandoffService.initialize({
    db: dbAdapter(db),
    loadPrototypeHtml: async () => null,
    snapshotBaseDir: snapDir,
  });
  return snapDir;
}

function writeSnapshot(ideaId: string, name: string, html = SNAPSHOT_HTML): string {
  const dir = join(snapDir!, ideaId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, html, 'utf-8');
  return file;
}

function seedIdea(db: Database.Database, id: string, ref: string, title: string): void {
  db.prepare('INSERT INTO ideas (id, ref, title) VALUES (?, ?, ?)').run(id, ref, title);
}

function seedDesign(
  db: Database.Database,
  opts: {
    ideaId: string;
    snapshotPath: string;
    source?: 'design-mode' | 'flow';
    sourceRunId?: string | null;
    supersededAt?: string | null;
    id?: string;
  },
): void {
  db.prepare(
    `INSERT INTO approved_designs
       (id, idea_id, prototype_artifact_id, prototype_revision, snapshot_path, approved_at,
        superseded_at, source, source_run_id)
     VALUES (?, ?, 'art-1', 1, ?, '2026-09-15T10:00:00.000Z', ?, ?, ?)`,
  ).run(
    opts.id ?? `apd-${opts.ideaId}`,
    opts.ideaId,
    opts.snapshotPath,
    opts.supersededAt ?? null,
    opts.source ?? 'design-mode',
    opts.sourceRunId ?? null,
  );
}

afterEach(() => {
  DesignHandoffService._resetForTesting();
  if (snapDir) {
    rmSync(snapDir, { recursive: true, force: true });
    snapDir = null;
  }
  if (outsideDir) {
    rmSync(outsideDir, { recursive: true, force: true });
    outsideDir = null;
  }
});

describe('cyboflow.design.forEntity', () => {
  it('resolves an IDEA to its own approved design', async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    seedDesign(db, { ideaId: 'ide-1', snapshotPath: writeSnapshot('ide-1', 'dm.html') });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.forEntity({ entityId: 'ide-1' })).toEqual({
      ideaId: 'ide-1',
      ideaRef: 'IDEA-004',
      ideaTitle: 'Spend flow',
      approvedAt: '2026-09-15T10:00:00.000Z',
      source: 'design-mode',
      sourceRunId: null,
    });
  });

  it('resolves an EPIC through its originating idea', async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run('epc-1', 'ide-1');
    seedDesign(db, {
      ideaId: 'ide-1',
      snapshotPath: writeSnapshot('ide-1', 'flow-run-1.html'),
      source: 'flow',
      sourceRunId: 'run-1',
    });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.forEntity({ entityId: 'epc-1' })).toMatchObject({
      ideaId: 'ide-1',
      ideaRef: 'IDEA-004',
      source: 'flow',
      sourceRunId: 'run-1',
    });
  });

  it('resolves a TASK by its own originating idea when it has one', async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    db.prepare('INSERT INTO tasks (id, originating_idea_id) VALUES (?, ?)').run('tsk-1', 'ide-1');
    seedDesign(db, { ideaId: 'ide-1', snapshotPath: writeSnapshot('ide-1', 'dm.html') });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.forEntity({ entityId: 'tsk-1' })).toMatchObject({
      ideaId: 'ide-1',
    });
  });

  it("resolves a TASK through parent_epic_id -> that epic's originating idea", async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run('epc-1', 'ide-1');
    db.prepare('INSERT INTO tasks (id, originating_idea_id, parent_epic_id) VALUES (?, ?, ?)').run(
      'tsk-1',
      null,
      'epc-1',
    );
    seedDesign(db, { ideaId: 'ide-1', snapshotPath: writeSnapshot('ide-1', 'dm.html') });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.forEntity({ entityId: 'tsk-1' })).toMatchObject({
      ideaId: 'ide-1',
    });
  });

  it('is null for an unknown entity, a broken lineage, and an idea with no approved design', async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    seedIdea(db, 'ide-bare', 'IDEA-009', 'No design yet');
    db.prepare('INSERT INTO tasks (id, originating_idea_id, parent_epic_id) VALUES (?, ?, ?)').run(
      'tsk-orphan',
      null,
      null,
    );
    db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run('epc-dangling', 'ide-gone');
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.forEntity({ entityId: 'nope' })).toBeNull();
    expect(await caller.cyboflow.design.forEntity({ entityId: 'tsk-orphan' })).toBeNull();
    expect(await caller.cyboflow.design.forEntity({ entityId: 'epc-dangling' })).toBeNull();
    expect(await caller.cyboflow.design.forEntity({ entityId: 'ide-bare' })).toBeNull();
  });

  it('ignores a SUPERSEDED design (only the current row counts)', async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    seedDesign(db, {
      ideaId: 'ide-1',
      snapshotPath: writeSnapshot('ide-1', 'old.html'),
      supersededAt: '2026-09-14T00:00:00.000Z',
    });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.forEntity({ entityId: 'ide-1' })).toBeNull();
  });

  it('rejects an empty entityId and throws PRECONDITION_FAILED with no db', async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(caller.cyboflow.design.forEntity({ entityId: '' })).rejects.toThrow();

    const unwired = appRouter.createCaller(createContext({}));
    await expect(unwired.cyboflow.design.forEntity({ entityId: 'ide-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<TRPCError>);
  });
});

describe('cyboflow.design.snapshotHtml', () => {
  it('serves the snapshot bytes for a current approved design', async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    seedDesign(db, { ideaId: 'ide-1', snapshotPath: writeSnapshot('ide-1', 'dm.html') });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.snapshotHtml({ ideaId: 'ide-1' })).toEqual({
      html: SNAPSHOT_HTML,
      approvedAt: '2026-09-15T10:00:00.000Z',
    });
  });

  it('is null when the idea has no approved design', async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.snapshotHtml({ ideaId: 'ide-1' })).toBeNull();
  });

  it('is null when the snapshot file has been pruned (the approval row outlives it)', async () => {
    const db = buildDb();
    const base = wireSnapshotDir(db);
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    seedDesign(db, { ideaId: 'ide-1', snapshotPath: join(base, 'ide-1', 'gone.html') });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.snapshotHtml({ ideaId: 'ide-1' })).toBeNull();
  });

  it('REFUSES a path outside the snapshot tree', async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    outsideDir = mkdtempSync(join(tmpdir(), 'cyboflow-outside-'));
    const secret = join(outsideDir, 'secret.html');
    writeFileSync(secret, 'PRIVATE', 'utf-8');
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    seedDesign(db, { ideaId: 'ide-1', snapshotPath: secret });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.snapshotHtml({ ideaId: 'ide-1' })).toBeNull();
  });

  it('REFUSES a traversal path that resolves out of the tree', async () => {
    const db = buildDb();
    const base = wireSnapshotDir(db);
    outsideDir = mkdtempSync(join(tmpdir(), 'cyboflow-outside-'));
    writeFileSync(join(outsideDir, 'secret.html'), 'PRIVATE', 'utf-8');
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    seedDesign(db, {
      ideaId: 'ide-1',
      snapshotPath: join(base, 'ide-1', '..', '..', '..', outsideDir.split('/').pop()!, 'secret.html'),
    });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.snapshotHtml({ ideaId: 'ide-1' })).toBeNull();
  });

  it('REFUSES a sibling directory whose name merely starts with the base', async () => {
    const db = buildDb();
    const base = wireSnapshotDir(db);
    const sibling = `${base}-evil`;
    mkdirSync(sibling, { recursive: true });
    outsideDir = sibling;
    writeFileSync(join(sibling, 'secret.html'), 'PRIVATE', 'utf-8');
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    seedDesign(db, { ideaId: 'ide-1', snapshotPath: join(sibling, 'secret.html') });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.snapshotHtml({ ideaId: 'ide-1' })).toBeNull();
  });

  it('is null for a directory masquerading as a snapshot file', async () => {
    const db = buildDb();
    const base = wireSnapshotDir(db);
    const asDir = join(base, 'ide-1', 'notafile.html');
    mkdirSync(asDir, { recursive: true });
    seedIdea(db, 'ide-1', 'IDEA-004', 'Spend flow');
    seedDesign(db, { ideaId: 'ide-1', snapshotPath: asDir });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    expect(await caller.cyboflow.design.snapshotHtml({ ideaId: 'ide-1' })).toBeNull();
  });

  it('rejects an empty ideaId and throws PRECONDITION_FAILED with no db', async () => {
    const db = buildDb();
    wireSnapshotDir(db);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(caller.cyboflow.design.snapshotHtml({ ideaId: '' })).rejects.toThrow();

    const unwired = appRouter.createCaller(createContext({}));
    await expect(unwired.cyboflow.design.snapshotHtml({ ideaId: 'ide-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<TRPCError>);
  });
});
