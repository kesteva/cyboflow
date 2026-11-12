/**
 * Remote artifact pull-back planning (spec M2 §5 D4): which reports pull, which files, from which run's environment,
 * and the readable error the producing agent sees when the files cannot be brought back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import {
  isSafeArtifactRelPath,
  pullRemoteRunArtifacts,
  REMOTE_ARTIFACT_MAX_BYTES,
  RemoteArtifactFetchError,
  remoteArtifactRelPaths,
  resolveRunHostId,
  setRemoteArtifactFetcher,
  type RemoteArtifactFetchRequest,
} from '../remoteArtifactPull';
import { ArtifactError } from '../../artifactRouter';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, host_id TEXT, session_id TEXT)');
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, host_id TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('s-remote', 'host-a');
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('s-local', null);
  db.prepare('INSERT INTO workflow_runs VALUES (?, ?, ?)').run('run-remote', 'host-a', 's-remote');
  db.prepare('INSERT INTO workflow_runs VALUES (?, ?, ?)').run('run-sentinel', null, 's-remote');
  db.prepare('INSERT INTO workflow_runs VALUES (?, ?, ?)').run('run-local', null, 's-local');
  db.prepare('INSERT INTO workflow_runs VALUES (?, ?, ?)').run('run-literal-local', 'local', null);
  return db;
}

let db: Database.Database;
let fetched: RemoteArtifactFetchRequest[];

beforeEach(() => {
  db = buildDb();
  fetched = [];
  setRemoteArtifactFetcher({ fetch: async (req) => void fetched.push(req) });
});

afterEach(() => {
  setRemoteArtifactFetcher(null);
  db.close();
});

describe('remoteArtifactRelPaths', () => {
  it('prototype atypes always carry the canonical document, whatever the payload says', () => {
    expect(remoteArtifactRelPaths('ui-prototype', '{"fileName":"../../x"}')).toEqual(['prototype/index.html']);
    expect(remoteArtifactRelPaths('interactive-prototype', undefined)).toEqual(['prototype/index.html']);
  });

  it('screenshots carry their safe, de-duplicated fileNames', () => {
    const payload = JSON.stringify({ fileNames: ['a.png', 'a.png', 'sub/b.png', '../x.png', '/abs.png', 7] });
    expect(remoteArtifactRelPaths('screenshots', payload)).toEqual(['a.png', 'sub/b.png']);
    expect(remoteArtifactRelPaths('screenshots', 'not json')).toEqual([]);
    expect(remoteArtifactRelPaths('screenshots', null)).toEqual([]);
  });

  it('every other atype is not file-based', () => {
    expect(remoteArtifactRelPaths('generic', '{"fileName":"x.html"}')).toBeNull();
    expect(remoteArtifactRelPaths('idea-spec', null)).toBeNull();
  });

  it('isSafeArtifactRelPath', () => {
    expect(isSafeArtifactRelPath('shot 1.png')).toBe(true);
    for (const bad of ['', '..', 'a/../b', './a', 'a//b', '/a', 'a\\b', 'a\nb']) expect(isSafeArtifactRelPath(bad)).toBe(false);
  });
});

describe('resolveRunHostId', () => {
  it('reads the run stamp, falls back to the session, and treats local/null as This Mac', () => {
    expect(resolveRunHostId(dbAdapter(db), 'run-remote')).toBe('host-a');
    expect(resolveRunHostId(dbAdapter(db), 'run-sentinel')).toBe('host-a');
    expect(resolveRunHostId(dbAdapter(db), 'run-local')).toBeNull();
    expect(resolveRunHostId(dbAdapter(db), 'run-literal-local')).toBeNull();
    expect(resolveRunHostId(dbAdapter(db), 'missing')).toBeNull();
  });

  it('a schema that predates host_id reads as This Mac', () => {
    const old = new Database(':memory:');
    old.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY)');
    old.prepare('INSERT INTO workflow_runs VALUES (?)').run('r');
    expect(resolveRunHostId(dbAdapter(old), 'r')).toBeNull();
    old.close();
  });
});

describe('pullRemoteRunArtifacts', () => {
  it('pulls the prototype for a remote run into the given local dir with the 10 MB cap', async () => {
    await pullRemoteRunArtifacts(dbAdapter(db), { runId: 'run-remote', atype: 'ui-prototype', localDir: '/local/runs/run-remote' });
    expect(fetched).toEqual([
      { hostId: 'host-a', runKey: 'run-remote', relPaths: ['prototype/index.html'], localDir: '/local/runs/run-remote', maxBytes: REMOTE_ARTIFACT_MAX_BYTES },
    ]);
    expect(REMOTE_ARTIFACT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it('pulls screenshots for a sentinel run whose session is remote', async () => {
    await pullRemoteRunArtifacts(dbAdapter(db), {
      runId: 'run-sentinel', atype: 'screenshots', payloadJson: '{"fileNames":["a.png"]}', localDir: '/l',
    });
    expect(fetched.map((f) => [f.hostId, f.runKey, f.relPaths])).toEqual([['host-a', 'run-sentinel', ['a.png']]]);
  });

  it('does nothing for a local run or a non-file atype', async () => {
    const select = vi.spyOn(db, 'prepare');
    await pullRemoteRunArtifacts(dbAdapter(db), { runId: 'run-remote', atype: 'idea-spec', localDir: '/l' });
    expect(select).not.toHaveBeenCalled();
    await pullRemoteRunArtifacts(dbAdapter(db), { runId: 'run-local', atype: 'ui-prototype', localDir: '/l' });
    await pullRemoteRunArtifacts(dbAdapter(db), { runId: 'run-literal-local', atype: 'screenshots', payloadJson: '{"fileNames":["a.png"]}', localDir: '/l' });
    expect(fetched).toEqual([]);
  });

  it('turns a fetch failure into a readable invalid_payload error', async () => {
    setRemoteArtifactFetcher({
      fetch: async () => {
        throw new RemoteArtifactFetchError("prototype/index.html was not found in this run's artifacts folder on the environment");
      },
    });
    const p = pullRemoteRunArtifacts(dbAdapter(db), { runId: 'run-remote', atype: 'ui-prototype', localDir: '/l' });
    await expect(p).rejects.toBeInstanceOf(ArtifactError);
    await expect(p).rejects.toMatchObject({
      code: 'invalid_payload',
      message: "remote_artifact_unavailable: prototype/index.html was not found in this run's artifacts folder on the environment",
    });
  });

  it('hides an unexpected fetcher error and refuses when nothing is wired', async () => {
    setRemoteArtifactFetcher({ fetch: async () => { throw new Error('ssh me@10.0.0.5 exploded'); } });
    await expect(pullRemoteRunArtifacts(dbAdapter(db), { runId: 'run-remote', atype: 'ui-prototype', localDir: '/l' }))
      .rejects.toThrow('remote_artifact_unavailable: the environment could not be read');
    setRemoteArtifactFetcher(null);
    await expect(pullRemoteRunArtifacts(dbAdapter(db), { runId: 'run-remote', atype: 'ui-prototype', localDir: '/l' }))
      .rejects.toThrow('remote environments are not available right now');
  });

  it('refuses more files than one report may bring back', async () => {
    const fileNames = Array.from({ length: 65 }, (_, i) => `s${i}.png`);
    await expect(pullRemoteRunArtifacts(dbAdapter(db), {
      runId: 'run-remote', atype: 'screenshots', payloadJson: JSON.stringify({ fileNames }), localDir: '/l',
    })).rejects.toThrow('65 files');
    expect(fetched).toEqual([]);
  });
});
