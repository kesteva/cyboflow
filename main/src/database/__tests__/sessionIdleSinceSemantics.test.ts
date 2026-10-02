/**
 * sessions.idle_since (migration 119) — the session's real last-REST boundary,
 * and the reason it is not `updated_at`.
 *
 * `updated_at` is bumped by ANY write to the row, so the quick-sessions board's
 * "quiet for N" label used to restart on things that were not activity: a
 * rename, a folder move, the boot sweep, a `stopped`→`failed` refinement.
 * `idle_since` is written ONLY at the busy→resting status transition, inside
 * updateSession's single UPDATE (IDLE_SINCE_ON_STATUS_CHANGE in database.ts) —
 * the one chokepoint every session-status write in the app funnels through, so
 * it covers all six substrate lanes without a per-manager wire point.
 *
 * The load-bearing assumption these tests pin is SQLite's UPDATE semantics:
 * every expression in a SET list is evaluated against the PRE-update row, so
 * the bare `status` inside the CASE is the OLD status even though `status = ?`
 * is assigned in the same statement. If that were false, arm 2 would never
 * fire and idle_since would never be stamped.
 *
 * Uses a REAL DatabaseService against a temp-file DB (sessionUpdatedAtSemantics
 * .test.ts pattern). Timestamps are seeded to fixed past values via raw SQL so a
 * spurious bump is detectable regardless of test speed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const SEEDED_UPDATED_AT = '2026-01-01 00:00:00';
const SEEDED_IDLE_SINCE = '2026-01-01 00:00:00';

let tmpDir: string;
let db: DatabaseService;
let projectId: number;

/** Create a session and pin updated_at/idle_since to known past instants. */
function createSession(id: string, opts: { status?: string; idleSince?: string | null } = {}): void {
  db.createSession({
    id,
    name: id,
    initial_prompt: 'p',
    worktree_name: `w-${id}`,
    worktree_path: join(tmpDir, `w-${id}`),
    project_id: projectId,
  });
  db.getDb()
    .prepare('UPDATE sessions SET updated_at = ?, status = ?, idle_since = ? WHERE id = ?')
    .run(
      SEEDED_UPDATED_AT,
      opts.status ?? 'running',
      opts.idleSince === undefined ? null : opts.idleSince,
      id,
    );
}

function read(id: string): { status: string; updated_at: string; idle_since: string | null } {
  return db
    .getDb()
    .prepare('SELECT status, updated_at, idle_since FROM sessions WHERE id = ?')
    .get(id) as { status: string; updated_at: string; idle_since: string | null };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-idlesince-'));
  db = new DatabaseService(join(tmpDir, 'test.db'));
  db.initialize();
  projectId = db.createProject('Proj', join(tmpDir, 'repo')).id;
});

afterEach(() => {
  db.getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('updateSession stamps idle_since at the busy→resting transition', () => {
  it.each(['completed', 'stopped', 'failed'])(
    'running → %s stamps idle_since',
    (resting) => {
      createSession('s1', { status: 'running' });
      db.updateSession('s1', { status: resting as 'completed' | 'stopped' | 'failed' });

      const row = read('s1');
      expect(row.status).toBe(resting);
      expect(row.idle_since).not.toBeNull();
      // Proves SQLite evaluated the CASE against the PRE-update status.
      expect(row.idle_since).not.toBe(SEEDED_IDLE_SINCE);
    },
  );

  it('pending → stopped stamps too (pending is a busy status)', () => {
    createSession('s1', { status: 'pending' });
    db.updateSession('s1', { status: 'stopped' });
    expect(read('s1').idle_since).not.toBeNull();
  });

  it('writes idle_since in the same space-separated UTC form as updated_at', () => {
    createSession('s1', { status: 'running' });
    db.updateSession('s1', { status: 'completed' });

    const row = read('s1');
    expect(row.idle_since).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Same shape as CURRENT_TIMESTAMP, so one strftime() normalizes both and
    // the ' ' vs 'T' ordering trap cannot open up between them.
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('updateSession clears idle_since when the session goes busy', () => {
  it.each(['running', 'pending'])('→ %s clears a previously stamped idle_since', (busy) => {
    createSession('s1', { status: 'completed', idleSince: SEEDED_IDLE_SINCE });
    db.updateSession('s1', { status: busy as 'running' | 'pending' });

    const row = read('s1');
    expect(row.status).toBe(busy);
    expect(row.idle_since).toBeNull();
  });

  it('busy → busy leaves it null (pending → running)', () => {
    createSession('s1', { status: 'pending' });
    db.updateSession('s1', { status: 'running' });
    expect(read('s1').idle_since).toBeNull();
  });
});

describe('a second turn on an already-rested session moves the boundary', () => {
  /**
   * The regression this pins is not the SQL — it is that SOMETHING must write
   * the busy status for arm 2 to have an edge to see. A PTY quick session whose
   * next turn was started by RAW TERMINAL KEYSTROKES (how a TUI AskUserQuestion
   * is answered) used to reach neither arm: nothing flipped it to 'running', so
   * the turn-end rest wrote `completed` over `completed` and idle_since kept the
   * PREVIOUS rest — the board rendered "quiet 19h" over a session that had been
   * working for hours. The manager's 'turn-start' event now supplies that edge
   * (index.ts's facade listener); this is the DB contract it depends on.
   */
  it('completed → running → completed restamps rather than preserving', () => {
    createSession('s1', { status: 'completed', idleSince: SEEDED_IDLE_SINCE });

    db.updateSession('s1', { status: 'running' }); // the turn-start flip
    expect(read('s1').idle_since).toBeNull(); // busy sessions have no quiet clock

    db.updateSession('s1', { status: 'completed' }); // the turn-end rest
    const row = read('s1');
    expect(row.idle_since).not.toBeNull();
    expect(row.idle_since).not.toBe(SEEDED_IDLE_SINCE);
  });

  it('without the busy edge the SAME two rests preserve the stale boundary (the defect)', () => {
    createSession('s1', { status: 'completed', idleSince: SEEDED_IDLE_SINCE });
    db.updateSession('s1', { status: 'completed' }); // turn-end with no turn-start
    expect(read('s1').idle_since).toBe(SEEDED_IDLE_SINCE);
  });
});

describe('idle_since survives writes that are not a rest boundary', () => {
  it('a resting → resting REFINEMENT preserves the original boundary', () => {
    // stopped → failed is a reclassification of the same rest, not a new one.
    createSession('s1', { status: 'stopped', idleSince: SEEDED_IDLE_SINCE });
    db.updateSession('s1', { status: 'failed' });

    const row = read('s1');
    expect(row.status).toBe('failed');
    expect(row.idle_since).toBe(SEEDED_IDLE_SINCE);
    // ...even though updated_at DID move, which is exactly the divergence the
    // column exists to create.
    expect(row.updated_at).not.toBe(SEEDED_UPDATED_AT);
  });

  it('re-writing the SAME resting status is idempotent for idle_since', () => {
    createSession('s1', { status: 'completed', idleSince: SEEDED_IDLE_SINCE });
    db.updateSession('s1', { status: 'completed' });
    db.updateSession('s1', { status: 'completed' });
    expect(read('s1').idle_since).toBe(SEEDED_IDLE_SINCE);
  });

  it('a write with no status at all never touches idle_since', () => {
    createSession('s1', { status: 'completed', idleSince: SEEDED_IDLE_SINCE });
    db.updateSession('s1', { name: 'renamed' });

    const row = read('s1');
    expect(row.idle_since).toBe(SEEDED_IDLE_SINCE);
    // The rename DID bump updated_at — the exact class of write that used to
    // reset the board's quiet clock.
    expect(row.updated_at).not.toBe(SEEDED_UPDATED_AT);
  });

  it('a presentation-only write touches neither clock', () => {
    createSession('s1', { status: 'completed', idleSince: SEEDED_IDLE_SINCE });
    db.getDb()
      .prepare('INSERT INTO folders (id, name, project_id) VALUES (?, ?, ?)')
      .run('folder-1', 'Bucket', projectId);
    db.updateSession('s1', { folder_id: 'folder-1' });

    const row = read('s1');
    expect(row.idle_since).toBe(SEEDED_IDLE_SINCE);
    expect(row.updated_at).toBe(SEEDED_UPDATED_AT);
  });
});

describe('markSessionsAsStopped (boot sweep) stamps last-known activity, not boot time', () => {
  it('a session that was running when the app died reports when it last did something', () => {
    createSession('s1', { status: 'running' });
    db.markSessionsAsStopped(['s1']);

    const row = read('s1');
    expect(row.status).toBe('stopped');
    // NOT CURRENT_TIMESTAMP: telling the board every crashed session went quiet
    // the instant the app relaunched is the bug this COALESCE prevents.
    expect(row.idle_since).toBe(SEEDED_UPDATED_AT);
    expect(row.updated_at).not.toBe(SEEDED_UPDATED_AT);
  });

  it('an already-rested row keeps its existing boundary (sweep is non-destructive)', () => {
    createSession('s1', { status: 'completed', idleSince: '2025-12-25 12:00:00' });
    db.markSessionsAsStopped(['s1']);
    expect(read('s1').idle_since).toBe('2025-12-25 12:00:00');
  });

  it('sweeps every id passed', () => {
    createSession('s1', { status: 'running' });
    createSession('s2', { status: 'pending' });
    db.markSessionsAsStopped(['s1', 's2']);
    expect(read('s1').idle_since).toBe(SEEDED_UPDATED_AT);
    expect(read('s2').idle_since).toBe(SEEDED_UPDATED_AT);
  });
});

describe('why migration 120 backfills instead of leaning on the read-side COALESCE', () => {
  // These two pin the defect an adversarial review caught: the COALESCE
  // fallback is equivalent to a real stamp only at the INSTANT of migration.
  // A row left NULL drifts away from its true boundary on the very writes 119
  // was built to stop mattering — so the backfill is load-bearing, not cosmetic.
  function boardIdleSince(id: string): string {
    return (
      db
        .getDb()
        .prepare(
          `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(idle_since, updated_at)) AS v
             FROM sessions WHERE id = ?`,
        )
        .get(id) as { v: string }
    ).v;
  }

  it('an UNSTAMPED resting row still resets its quiet clock on a rename', () => {
    createSession('legacy', { status: 'completed', idleSince: null });
    expect(boardIdleSince('legacy')).toBe('2026-01-01T00:00:00Z');

    // A rename carries no status, so it never reaches the idle_since CASE —
    // but it does bump updated_at, and COALESCE follows it forward.
    db.updateSession('legacy', { name: 'renamed' });
    expect(boardIdleSince('legacy')).not.toBe('2026-01-01T00:00:00Z');
  });

  it('an UNSTAMPED resting row also resets on a resting→resting status write', () => {
    createSession('legacy', { status: 'completed', idleSince: null });
    // The ELSE arm preserves NULL, and updated_at is bumped in the same UPDATE.
    db.updateSession('legacy', { status: 'stopped' });
    expect(read('legacy').idle_since).toBeNull();
    expect(boardIdleSince('legacy')).not.toBe('2026-01-01T00:00:00Z');
  });

  it('the same row, once stamped, is immune to both', () => {
    createSession('stamped', { status: 'completed', idleSince: SEEDED_IDLE_SINCE });
    db.updateSession('stamped', { name: 'renamed' });
    db.updateSession('stamped', { status: 'stopped' });
    expect(boardIdleSince('stamped')).toBe('2026-01-01T00:00:00Z');
  });
});

describe('the board read', () => {
  it('COALESCEs a NULL idle_since (a busy row) back to updated_at', () => {
    createSession('s1', { status: 'completed', idleSince: null });
    const row = db
      .getDb()
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(idle_since, updated_at)) AS idle_since_iso
           FROM sessions WHERE id = ?`,
      )
      .get('s1') as { idle_since_iso: string };
    expect(row.idle_since_iso).toBe('2026-01-01T00:00:00Z');
  });
});
