import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MergeBackStore, MergeBackStateConflictError, InvalidMergeBackTransitionError, type MergeBackChange } from '../mergeBackStore';
import type { DatabaseLike } from '../../types';

const SQL = readFileSync(join(__dirname, '..', '..', '..', 'database', 'migrations', '153_session_merge_backs.sql'), 'utf-8');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let raw: Database.Database;
let store: MergeBackStore;
let changes: MergeBackChange[];
let tick: number;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);
            CREATE TABLE sessions (id TEXT PRIMARY KEY);
            CREATE TABLE hosts (id TEXT PRIMARY KEY);
            INSERT INTO projects VALUES (1, 'p'); INSERT INTO sessions VALUES ('s1'), ('s2');
            INSERT INTO hosts VALUES ('h1'), ('h2');`);
  raw.exec(SQL);
  changes = [];
  tick = 0;
  store = new MergeBackStore(raw as unknown as DatabaseLike, {
    now: () => new Date(Date.UTC(2026, 9, 22, 12, 0, tick++)),
    onChange: (c) => changes.push(c),
  });
});

const base = { hostId: 'h1', projectId: 1, mergeKey: 'k1', branch: 'feat', state: 'bare_ready' as const };

describe('MergeBackStore', () => {
  it('creates, reads and lists rows with ISO timestamps', async () => {
    const row = await store.create({ sessionId: 's1', ...base, baseSha: 'abc' });
    expect(row).toMatchObject({ sessionId: 's1', state: 'bare_ready', baseSha: 'abc', importSha: null, lastError: null });
    expect(row.createdAt).toMatch(ISO);
    expect(row.updatedAt).toMatch(ISO);
    await store.create({ sessionId: 's2', ...base, hostId: 'h2', mergeKey: 'k2', state: 'remote_ready' });
    expect(store.get('s1')?.branch).toBe('feat');
    expect(store.get('zzz')).toBeNull();
    expect(store.listForHost('h2').map((r) => r.sessionId)).toEqual(['s2']);
    expect(store.listByState(['bare_ready', 'remote_ready']).map((r) => r.sessionId)).toEqual(['s1', 's2']);
    expect(store.listByState(['merged'])).toEqual([]);
    expect(store.listByState([])).toEqual([]);
    expect(changes.map((c) => [c.sessionId, c.previous])).toEqual([['s1', null], ['s2', null]]);
  });

  it('rejects a duplicate session and an unknown state', async () => {
    await store.create({ sessionId: 's1', ...base });
    await expect(store.create({ sessionId: 's1', ...base })).rejects.toThrow();
    await expect(store.create({ sessionId: 's2', ...base, state: 'bogus' as never })).rejects.toThrow(/Unknown/);
  });

  it('transitions with a patch and bumps updated_at', async () => {
    const created = await store.create({ sessionId: 's1', ...base });
    const next = await store.transition('s1', { from: ['bare_ready'], to: 'base_pushed', patch: { baseSha: 'sha1', remoteWorktreePath: '/r/w' } });
    expect(next).toMatchObject({ state: 'base_pushed', baseSha: 'sha1', remoteWorktreePath: '/r/w' });
    expect(next.updatedAt > created.updatedAt).toBe(true);
    expect(changes.at(-1)).toMatchObject({ state: 'base_pushed', previous: 'bare_ready' });
  });

  it('a null patch value clears a column; an omitted one leaves it', async () => {
    await store.create({ sessionId: 's1', ...base, baseSha: 'abc' });
    await store.setError('s1', 'boom');
    const next = await store.transition('s1', { from: ['bare_ready'], to: 'base_pushed', patch: { lastError: null } });
    expect(next.lastError).toBeNull();
    expect(next.baseSha).toBe('abc');
  });

  it('compare-and-set: a stale from throws MergeBackStateConflictError and changes nothing', async () => {
    await store.create({ sessionId: 's1', ...base });
    const err = await store.transition('s1', { from: ['remote_ready'], to: 'checkpointed' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MergeBackStateConflictError);
    expect((err as MergeBackStateConflictError).actual).toBe('bare_ready');
    expect(store.get('s1')?.state).toBe('bare_ready');
    const missing = await store.transition('nope', { from: ['bare_ready'], to: 'base_pushed' }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(MergeBackStateConflictError);
    expect(changes).toHaveLength(1);
  });

  it('refuses a disallowed edge even when from matches', async () => {
    await store.create({ sessionId: 's1', ...base });
    await expect(store.transition('s1', { from: ['bare_ready'], to: 'merged' })).rejects.toBeInstanceOf(InvalidMergeBackTransitionError);
    expect(store.get('s1')?.state).toBe('bare_ready');
  });

  it('two racing transitions: exactly one wins', async () => {
    await store.create({ sessionId: 's1', ...base });
    const results = await Promise.allSettled([
      store.transition('s1', { from: ['bare_ready'], to: 'base_pushed' }),
      store.transition('s1', { from: ['bare_ready'], to: 'abandoned' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(store.get('s1')?.state).toBe('base_pushed');
  });

  it('setError keeps the state, records and clears the message, ignores unknown sessions', async () => {
    await store.create({ sessionId: 's1', ...base });
    expect((await store.setError('s1', 'ssh down'))?.lastError).toBe('ssh down');
    expect(store.get('s1')?.state).toBe('bare_ready');
    expect((await store.setError('s1', null))?.lastError).toBeNull();
    expect(await store.setError('nope', 'x')).toBeNull();
  });

  it('a throwing listener does not fail the write', async () => {
    const s = new MergeBackStore(raw as unknown as DatabaseLike, { onChange: () => { throw new Error('x'); } });
    await expect(s.create({ sessionId: 's1', ...base })).resolves.toMatchObject({ sessionId: 's1' });
  });
});
