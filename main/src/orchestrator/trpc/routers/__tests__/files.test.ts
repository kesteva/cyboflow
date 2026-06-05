/**
 * Integration tests for the orchestrator tRPC cyboflow.files procedures
 * (session-keyed File Explorer).
 *
 * A thin router test mirroring the listFiles/readFile cases in runs.test.ts:
 *   (a) Happy path: a seeded session with a real temp worktree returns the
 *       expected listing / file content.
 *   (b) Missing ctx.db → TRPCError PRECONDITION_FAILED (the db guard).
 *   (c) Unknown sessionId → RunFileError('session-not-found') maps to a
 *       TRPCError NOT_FOUND via withRunFileErrorMapping.
 *
 * GATE_SCHEMA omits the `sessions` table, so each test layers a minimal one on
 * top (id + worktree_path — the only columns the session resolver reads).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../__test_fixtures__/orchestratorTestDb';

const SESSION_ID = 'session-files-001';

describe('cyboflow.files.list / read', () => {
  let db: Database.Database;
  let worktree: string;

  beforeEach(() => {
    db = createTestDb();
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, worktree_path TEXT NOT NULL)');
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-files-router-'));
    db.prepare('INSERT INTO sessions (id, worktree_path) VALUES (?, ?)').run(SESSION_ID, worktree);
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // (a) Happy path
  // -------------------------------------------------------------------------
  it('(a) list returns the selected session worktree, dirs-first with .git excluded', async () => {
    fs.writeFileSync(path.join(worktree, 'README.md'), '# hi');
    fs.mkdirSync(path.join(worktree, 'src'));
    fs.mkdirSync(path.join(worktree, '.git'));

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const entries = await caller.cyboflow.files.list({ sessionId: SESSION_ID });

    expect(entries.map((e) => e.name)).toEqual(['src', 'README.md']);
  });

  it('(a) read returns UTF-8 content for a session-worktree file', async () => {
    fs.writeFileSync(path.join(worktree, 'note.md'), 'line1\nline2');

    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    const result = await caller.cyboflow.files.read({ sessionId: SESSION_ID, path: 'note.md' });

    expect(result).toEqual({
      path: 'note.md',
      content: 'line1\nline2',
      size: Buffer.byteLength('line1\nline2'),
      unviewableReason: null,
    });
  });

  // -------------------------------------------------------------------------
  // (b) Missing ctx.db → PRECONDITION_FAILED
  // -------------------------------------------------------------------------
  it('(b) list with missing ctx.db → TRPCError PRECONDITION_FAILED', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.files.list({ sessionId: SESSION_ID }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });

  it('(b) read with missing ctx.db → TRPCError PRECONDITION_FAILED', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.files.read({ sessionId: SESSION_ID, path: 'note.md' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });

  // -------------------------------------------------------------------------
  // (c) Unknown sessionId → NOT_FOUND (RunFileError('session-not-found') mapped)
  // -------------------------------------------------------------------------
  it('(c) list on an unknown sessionId → TRPCError NOT_FOUND', async () => {
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.files.list({ sessionId: 'no-such-session' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });

  it('(c) read on an unknown sessionId → TRPCError NOT_FOUND', async () => {
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
    await expect(
      caller.cyboflow.files.read({ sessionId: 'no-such-session', path: 'note.md' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });
});
