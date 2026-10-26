import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { createSiblingInstances, readWorktreeRefsFromDb } from '../siblingInstances';
import type { InstanceRecord } from '../../utils/spawnMarker';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-instances-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** A data dir with a sessions.db placeholder and optional liveness records. */
function dataDir(name: string, records: InstanceRecord[] = [], withDb = true): string {
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, 'instances'), { recursive: true });
  if (withDb) fs.writeFileSync(path.join(dir, 'sessions.db'), '');
  for (const r of records) fs.writeFileSync(path.join(dir, 'instances', `${r.instanceId}.json`), JSON.stringify(r));
  return dir;
}

const rec = (instanceId: string, pid: number): InstanceRecord => ({ instanceId, pid, startedAt: '2026-10-26T00:00:00Z' });

async function readRecords(dir: string): Promise<InstanceRecord[]> {
  try {
    return fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as InstanceRecord);
  } catch {
    return [];
  }
}

const ALIVE = new Set([501, 502, 503]);

function siblings(over: {
  selfDataDir: string;
  refs: Record<string, string[] | 'throw'>;
  now?: () => number;
  ages?: Map<number, number>;
}) {
  return createSiblingInstances({
    selfDataDir: over.selfDataDir,
    homeDir: home,
    readInstanceRecords: readRecords,
    isPidAlive: (pid) => ALIVE.has(pid),
    // Unknown ages by default ⇒ pid liveness alone (never the real `ps` in tests).
    readProcessAges: async () => over.ages ?? new Map(),
    now: over.now,
    readWorktreeRefs: (dbPath) => {
      const r = over.refs[path.basename(path.dirname(dbPath))];
      if (r === 'throw') throw new Error('SQLITE_CORRUPT');
      return r ?? [];
    },
  });
}

describe('createSiblingInstances — worktreeClaims', () => {
  it('reads canonical variants even when not running, and running smoke dirs; skips self and dead smoke dirs', async () => {
    const self = dataDir('.cyboflow', [rec('self', 501)]);
    dataDir('.cyboflow_dev_dmg'); // canonical, not running
    dataDir('.cyboflow_test', [rec('smoke-live', 502)]); // running smoke instance
    dataDir('.cyboflow_smoke', [rec('smoke-dead', 999)]); // abandoned smoke dir
    const claims = await siblings({
      selfDataDir: self,
      refs: {
        '.cyboflow': ['/wt/self-owned'],
        '.cyboflow_dev_dmg': ['/wt/dmg'],
        '.cyboflow_test': ['/wt/test'],
        '.cyboflow_smoke': ['/wt/abandoned'],
      },
    }).worktreeClaims();
    expect(Object.fromEntries(claims.claimedPaths)).toEqual({
      '/wt/dmg': path.join(home, '.cyboflow_dev_dmg'),
      '/wt/test': path.join(home, '.cyboflow_test'),
    });
    expect(claims.unreadableDataDirs).toEqual([]);
  });

  it('reports a sibling DB that exists but cannot be read (the fail-closed signal)', async () => {
    const self = dataDir('.cyboflow_dev');
    dataDir('.cyboflow');
    const claims = await siblings({ selfDataDir: self, refs: { '.cyboflow': 'throw' } }).worktreeClaims();
    expect(claims.unreadableDataDirs).toEqual([path.join(home, '.cyboflow')]);
  });

  it('a canonical dir with no sessions.db (variant never installed) is simply absent, not unreadable', async () => {
    const self = dataDir('.cyboflow');
    dataDir('.cyboflow_dev', [], false);
    const claims = await siblings({ selfDataDir: self, refs: { '.cyboflow_dev': 'throw' } }).worktreeClaims();
    expect(claims.unreadableDataDirs).toEqual([]);
    expect(claims.claimedPaths.size).toBe(0);
  });

  it('caches briefly, then re-reads', async () => {
    const self = dataDir('.cyboflow');
    dataDir('.cyboflow_dev');
    const refs: Record<string, string[]> = { '.cyboflow_dev': ['/wt/a'] };
    let t = 0;
    const s = siblings({ selfDataDir: self, refs, now: () => t });
    expect((await s.worktreeClaims()).claimedPaths.has('/wt/a')).toBe(true);
    refs['.cyboflow_dev'] = ['/wt/b'];
    t = 1_000;
    expect((await s.worktreeClaims()).claimedPaths.has('/wt/b')).toBe(false);
    t = 5_000;
    expect((await s.worktreeClaims()).claimedPaths.has('/wt/b')).toBe(true);
  });
});

describe('createSiblingInstances — liveMainPids', () => {
  it("collects live sibling main pids only, never this instance's own dir", async () => {
    const self = dataDir('.cyboflow', [rec('self', 501)]);
    dataDir('.cyboflow_dev_dmg', [rec('dmg', 502), rec('dmg-stale', 998)]);
    dataDir('.cyboflow_test', [rec('test', 503)], false);
    const pids = await siblings({ selfDataDir: self, refs: {} }).liveMainPids();
    expect(Object.fromEntries(pids)).toEqual({ 502: 'dmg', 503: 'test' });
  });
});

describe('createSiblingInstances — recycled pids', () => {
  // Records are stamped 2026-10-26T00:00:00Z; "now" is one hour later.
  const NOW = Date.parse('2026-10-26T01:00:00Z');

  it('drops a record whose pid now belongs to a process that started after the record', async () => {
    const self = dataDir('.cyboflow');
    dataDir('.cyboflow_dev_dmg', [rec('genuine', 501), rec('recycled', 502)]);
    const ages = new Map([
      [501, 2 * 3600], // started an hour before the record: the instance itself
      [502, 60], // started a minute ago: someone else now owns that pid
    ]);
    const pids = await siblings({ selfDataDir: self, refs: {}, now: () => NOW, ages }).liveMainPids();
    expect(Object.fromEntries(pids)).toEqual({ 501: 'genuine' });
  });

  it('a smoke dir kept "running" only by a recycled pid no longer claims worktrees', async () => {
    const self = dataDir('.cyboflow');
    dataDir('.cyboflow_test', [rec('stale', 503)]);
    const claims = await siblings({
      selfDataDir: self,
      refs: { '.cyboflow_test': ['/wt/abandoned'] },
      now: () => NOW,
      ages: new Map([[503, 30]]),
    }).worktreeClaims();
    expect(claims.claimedPaths.size).toBe(0);
  });
});

describe('readWorktreeRefsFromDb', () => {
  it('reads sessions + workflow_runs readonly, tolerating a schema without workflow_runs', () => {
    const file = path.join(home, 'sessions.db');
    const w = new Database(file);
    w.exec("CREATE TABLE sessions (id TEXT, worktree_path TEXT); INSERT INTO sessions VALUES ('a', '/wt/a'), ('b', ''), ('c', NULL);");
    w.close();
    expect(readWorktreeRefsFromDb(file)).toEqual(['/wt/a']);

    const w2 = new Database(file);
    w2.exec("CREATE TABLE workflow_runs (id TEXT, worktree_path TEXT); INSERT INTO workflow_runs VALUES ('r', '/wt/r');");
    w2.close();
    expect(readWorktreeRefsFromDb(file).sort()).toEqual(['/wt/a', '/wt/r']);
  });

  it('throws on a file that is not a database', () => {
    const file = path.join(home, 'sessions.db');
    fs.writeFileSync(file, 'not a database, just text long enough to fail the header check'.repeat(20));
    expect(() => readWorktreeRefsFromDb(file)).toThrow();
  });
});
