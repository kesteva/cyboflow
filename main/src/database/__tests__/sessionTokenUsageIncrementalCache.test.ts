/**
 * getSessionTokenUsage (main/src/database/database.ts) caches a per-session
 * running total plus the last-folded session_outputs.id, so the 5s stats
 * poll only SELECTs + JSON.parses rows appended since the previous call
 * instead of re-parsing the session's entire output history every tick.
 *
 * "Nothing new was parsed" is asserted with a global JSON.parse spy:
 * sumSessionOutputTokenUsage (main/src/database/sessionTokenUsage.ts) is the
 * only JSON.parse call in this path, one per fetched row, so a call count of
 * zero is direct proof the second call fetched (and therefore parsed) no rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

let tmpDir: string;
let db: DatabaseService;
let projectId: number;
const sessionId = 'session-1';

function resultOutput(usage: { input_tokens: number; output_tokens: number }): string {
  return JSON.stringify({ type: 'result', usage });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-tokencache-'));
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

describe('getSessionTokenUsage incremental cache', () => {
  it('folds newly appended rows into the running total across calls', () => {
    db.addSessionOutput(sessionId, 'json', resultOutput({ input_tokens: 10, output_tokens: 5 }));

    expect(db.getSessionTokenUsage(sessionId)).toMatchObject({
      totalInputTokens: 10,
      totalOutputTokens: 5,
      messageCount: 1,
    });

    db.addSessionOutput(sessionId, 'json', resultOutput({ input_tokens: 3, output_tokens: 2 }));

    expect(db.getSessionTokenUsage(sessionId)).toMatchObject({
      totalInputTokens: 13,
      totalOutputTokens: 7,
      messageCount: 2,
    });
  });

  it('a second call with no new rows parses nothing new and returns the same total', () => {
    db.addSessionOutput(sessionId, 'json', resultOutput({ input_tokens: 10, output_tokens: 5 }));
    const first = db.getSessionTokenUsage(sessionId);

    const parseSpy = vi.spyOn(JSON, 'parse');
    const second = db.getSessionTokenUsage(sessionId);
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();

    expect(second).toEqual(first);
  });

  it('invalidates the cache when session_outputs is cleared, so a fresh read starts from zero', () => {
    db.addSessionOutput(sessionId, 'json', resultOutput({ input_tokens: 10, output_tokens: 5 }));
    db.getSessionTokenUsage(sessionId);

    db.clearSessionOutputs(sessionId);
    expect(db.getSessionTokenUsage(sessionId)).toMatchObject({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      messageCount: 0,
    });

    db.addSessionOutput(sessionId, 'json', resultOutput({ input_tokens: 1, output_tokens: 1 }));
    expect(db.getSessionTokenUsage(sessionId)).toMatchObject({
      totalInputTokens: 1,
      totalOutputTokens: 1,
      messageCount: 1,
    });
  });

  it('invalidates the cache when the session is archived', () => {
    db.addSessionOutput(sessionId, 'json', resultOutput({ input_tokens: 10, output_tokens: 5 }));
    db.getSessionTokenUsage(sessionId);

    db.archiveSession(sessionId);
    db.restoreSession(sessionId);

    // No rows changed, so re-deriving from scratch must land on the same total.
    expect(db.getSessionTokenUsage(sessionId)).toMatchObject({
      totalInputTokens: 10,
      totalOutputTokens: 5,
      messageCount: 1,
    });
  });
});
