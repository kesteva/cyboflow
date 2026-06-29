/**
 * Unit tests for permissionModeResolver — the single resolution point for the
 * agent permission-mode choice governing workflow runs on both CLI substrates.
 *
 * Behaviors covered (mirroring substrateResolver.test.ts):
 *  1. resolvePermissionMode honors the override ladder in precedence order
 *     (requestedMode > frontmatterMode > globalDefaultMode > 'default' floor):
 *     one case per level winning, a full-precedence case, the floor case, and
 *     an invalid-value-ignored case (fail-soft fall-through).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  resolvePermissionMode,
  resolveRunAgentPermissionMode,
  DEFAULT_PERMISSION_MODE,
} from '../permissionModeResolver';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

describe('resolvePermissionMode — override ladder', () => {
  it("floors to 'default' when nothing is set (zero-behavior-change invariant)", () => {
    expect(resolvePermissionMode({})).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode({})).toBe('default');
  });

  it('requestedMode (explicit per-run UI choice) wins over every lower level', () => {
    const result = resolvePermissionMode({
      requestedMode: 'dontAsk',
      frontmatterMode: 'acceptEdits',
      globalDefaultMode: 'auto',
    });
    expect(result).toBe('dontAsk');
  });

  it('an absent/invalid requestedMode falls through to the next level (fail-soft)', () => {
    // Per-run override not supplied (undefined) → frontmatter wins.
    expect(
      resolvePermissionMode({ requestedMode: undefined, frontmatterMode: 'auto' }),
    ).toBe('auto');
    // Garbage requested value is ignored → falls through to global default.
    expect(
      resolvePermissionMode({ requestedMode: 'garbage', globalDefaultMode: 'acceptEdits' }),
    ).toBe('acceptEdits');
  });

  it('frontmatterMode wins when set, even with the global default present', () => {
    const result = resolvePermissionMode({
      frontmatterMode: 'acceptEdits',
      globalDefaultMode: 'auto',
    });
    expect(result).toBe('acceptEdits');
  });

  it('globalDefaultMode wins when requested + frontmatter are absent', () => {
    expect(resolvePermissionMode({ globalDefaultMode: 'auto' })).toBe('auto');
    expect(resolvePermissionMode({ globalDefaultMode: 'dontAsk' })).toBe('dontAsk');
  });

  it('full precedence: requested beats frontmatter beats globalDefault', () => {
    // Highest set level should win. Distinct valid values at every rung.
    expect(
      resolvePermissionMode({
        requestedMode: 'dontAsk',
        frontmatterMode: 'acceptEdits',
        globalDefaultMode: 'auto',
      }),
    ).toBe('dontAsk');

    // Drop requested → frontmatter wins.
    expect(
      resolvePermissionMode({ frontmatterMode: 'acceptEdits', globalDefaultMode: 'auto' }),
    ).toBe('acceptEdits');

    // Drop frontmatter → globalDefault wins.
    expect(resolvePermissionMode({ globalDefaultMode: 'auto' })).toBe('auto');
  });

  it("'auto' is a recognized mode and resolves through every level", () => {
    expect(resolvePermissionMode({ requestedMode: 'auto' })).toBe('auto');
    expect(resolvePermissionMode({ frontmatterMode: 'auto' })).toBe('auto');
    expect(resolvePermissionMode({ globalDefaultMode: 'auto' })).toBe('auto');
  });

  it('an invalid value at a level is ignored and resolution falls through (fail-soft)', () => {
    // A typo at the highest level must NOT throw and must NOT win — resolution
    // falls through to the next valid level (here frontmatter).
    const result = resolvePermissionMode({
      requestedMode: 'acceptEdit', // typo — invalid
      frontmatterMode: 'acceptEdits',
      globalDefaultMode: 'default',
    });
    expect(result).toBe('acceptEdits');
  });

  it('an invalid value at every level falls through to the default floor', () => {
    const result = resolvePermissionMode({
      requestedMode: 'yolo',
      frontmatterMode: 'bogus',
      globalDefaultMode: '',
    });
    expect(result).toBe('default');
  });

  it('null at any level is ignored (fail-soft, not a value)', () => {
    expect(
      resolvePermissionMode({
        requestedMode: null,
        frontmatterMode: null,
        globalDefaultMode: 'dontAsk',
      }),
    ).toBe('dontAsk');
  });
});

// ---------------------------------------------------------------------------
// resolveRunAgentPermissionMode — the session-is-authority join resolver
// (permission-mode redesign §3a). Keyed on the RUN via workflow_runs → sessions.
// ---------------------------------------------------------------------------

/**
 * Minimal schema for the run→session join: just the two columns the resolver
 * touches (`workflow_runs.session_id` + `sessions.agent_permission_mode`).
 */
function buildJoinDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, session_id TEXT)');
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
  return db;
}

function seedRun(db: Database.Database, runId: string, sessionId: string | null): void {
  db.prepare('INSERT INTO workflow_runs (id, session_id) VALUES (?, ?)').run(runId, sessionId);
}

function seedSession(db: Database.Database, sessionId: string, mode: string | null): void {
  db.prepare('INSERT INTO sessions (id, agent_permission_mode) VALUES (?, ?)').run(sessionId, mode);
}

describe('resolveRunAgentPermissionMode — session-via-run join', () => {
  it('SESSION HIT: returns the owning session mode when set (the execution authority)', () => {
    const db = buildJoinDb();
    seedSession(db, 'sess-1', 'dontAsk');
    seedRun(db, 'run-1', 'sess-1');

    // The session mode wins over the supplied global default.
    expect(resolveRunAgentPermissionMode(dbAdapter(db), 'run-1', 'default')).toBe('dontAsk');
    db.close();
  });

  it("flow shape (sessionId===runId) still resolves the HOST session via the join, not a WHERE sessions.id=runId miss", () => {
    // The run id and the session id are DISTINCT (the join is by session_id), so a
    // naive `WHERE sessions.id = runId` would miss — the join is the fix (§3a #1).
    const db = buildJoinDb();
    seedSession(db, 'sess-host', 'acceptEdits');
    seedRun(db, 'flow-run', 'sess-host');

    expect(resolveRunAgentPermissionMode(dbAdapter(db), 'flow-run', 'default')).toBe('acceptEdits');
    db.close();
  });

  it('NULL session mode → falls back to the supplied global default', () => {
    const db = buildJoinDb();
    seedSession(db, 'sess-2', null); // mode column NULL ⇒ inherit the global default
    seedRun(db, 'run-2', 'sess-2');

    expect(resolveRunAgentPermissionMode(dbAdapter(db), 'run-2', 'auto')).toBe('auto');
    // And to the resolver's own 'default' floor when the caller omits the arg.
    expect(resolveRunAgentPermissionMode(dbAdapter(db), 'run-2')).toBe('default');
    db.close();
  });

  it('JOIN MISS (legacy sentinel, session_id NULL) → global default, never strands the run', () => {
    // A run whose session_id was never backfilled: the LEFT JOIN yields m=NULL.
    // It must fall back to the default (→ conservative router gate), NOT throw or
    // strand a dontAsk/acceptEdits session in prompt-everything.
    const db = buildJoinDb();
    seedRun(db, 'run-orphan', null);

    expect(resolveRunAgentPermissionMode(dbAdapter(db), 'run-orphan', 'default')).toBe('default');
    // The fallback is whatever global default the caller threads.
    expect(resolveRunAgentPermissionMode(dbAdapter(db), 'run-orphan', 'acceptEdits')).toBe('acceptEdits');
    db.close();
  });

  it('JOIN MISS (session_id points at a missing session row) → global default', () => {
    const db = buildJoinDb();
    seedRun(db, 'run-dangling', 'sess-gone'); // no such session row

    expect(resolveRunAgentPermissionMode(dbAdapter(db), 'run-dangling', 'auto')).toBe('auto');
    db.close();
  });

  it('UNKNOWN run id → global default (no row at all)', () => {
    const db = buildJoinDb();
    expect(resolveRunAgentPermissionMode(dbAdapter(db), 'nope', 'dontAsk')).toBe('dontAsk');
    db.close();
  });

  it('invalid mode value in the column is ignored (fail-soft) → global default', () => {
    const db = buildJoinDb();
    seedSession(db, 'sess-bad', 'yolo'); // not a PermissionMode
    seedRun(db, 'run-bad', 'sess-bad');

    expect(resolveRunAgentPermissionMode(dbAdapter(db), 'run-bad', 'default')).toBe('default');
    db.close();
  });
});
