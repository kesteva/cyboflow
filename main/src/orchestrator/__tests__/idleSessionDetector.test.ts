/**
 * Unit tests for IdleSessionDetector.
 *
 * Targets:
 *  1. Mint: an idle, unviewed, interactive quick session → one blocking
 *     human_task with source='idle-session:<id>' and runId=chat_run_id.
 *  2. Idempotency: repeated scans do not double-mint (a pending item exists).
 *  3. Threshold: a session that rested inside the window is not surfaced.
 *  4. Scope exclusions: sdk substrate / non-quick / main-repo / archived /
 *     running / viewed-since sessions are all skipped.
 *  5. Auto-resolve: a pending idle item whose session left scope (viewed, or a
 *     new turn started) is resolved.
 *  6. Disabled: no minting, but outstanding items still drain (auto-resolve runs).
 *  7. Scheduling: the 60s interval fires scan; stop() cancels it.
 *
 * DB tests use in-memory better-sqlite3 with minimal `sessions` + `review_items`
 * tables (only the columns the detector's SQL touches). The injected
 * applyReviewItem spy writes minimal rows so idempotency + auto-resolve exercise
 * the detector's real SQL rather than a canned fake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { IdleSessionDetector, type IdleSessionReviewSettings } from '../idleSessionDetector';
import type { ReviewItemCreate, ReviewItemTriage } from '../reviewItemRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';

// ---------------------------------------------------------------------------
// Fixed clock — deterministic idle math
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse('2026-07-10T19:00:00.000Z');
const now = () => NOW_MS;
/** ISO string for a timestamp `minutesAgo` before NOW. */
const iso = (minutesAgo: number) => new Date(NOW_MS - minutesAgo * 60_000).toISOString();
/**
 * SQLite CURRENT_TIMESTAMP / datetime() wire format: 'YYYY-MM-DD HH:MM:SS' in
 * UTC (space separator, no 'T', no 'Z'). This is what sessions.updated_at and
 * last_viewed_at actually hold — NOT lexicographically comparable to `iso()`.
 */
const sqliteTs = (minutesAgo: number) =>
  new Date(NOW_MS - minutesAgo * 60_000).toISOString().slice(0, 19).replace('T', ' ');

// ---------------------------------------------------------------------------
// Minimal DB
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      project_id INTEGER,
      substrate TEXT,
      is_quick INTEGER,
      is_main_repo INTEGER,
      archived INTEGER,
      status TEXT,
      last_viewed_at TEXT,
      updated_at TEXT,
      chat_run_id TEXT
    );
    -- Minimal workflow_runs so the candidate query's LEFT JOIN (dangling-FK
    -- guard on chat_run_id) resolves. Deliberately shares columns (substrate/
    -- status/updated_at) with sessions to prove the s.-qualified predicate
    -- is unambiguous under the join.
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      substrate TEXT,
      status TEXT,
      updated_at TEXT
    );
    CREATE TABLE review_items (
      id TEXT PRIMARY KEY,
      project_id INTEGER,
      kind TEXT,
      status TEXT,
      source TEXT,
      created_at TEXT
    );
  `);
  return db;
}

interface SeedSessionOverrides {
  id?: string;
  name?: string;
  project_id?: number;
  substrate?: string;
  is_quick?: number;
  is_main_repo?: number;
  archived?: number;
  status?: string;
  last_viewed_at?: string | null;
  updated_at?: string;
  chat_run_id?: string | null;
  /** When false, the chat_run_id's workflow_runs row is NOT seeded (dangling FK). */
  seedRun?: boolean;
}

/** Defaults describe an in-scope, idle (rested 10 min ago), unviewed session. */
function seedSession(db: Database.Database, o: SeedSessionOverrides = {}): string {
  const s = {
    id: o.id ?? 's1',
    name: o.name ?? 'quick-20260710-190000',
    project_id: o.project_id ?? 7,
    substrate: o.substrate ?? 'interactive',
    is_quick: o.is_quick ?? 1,
    is_main_repo: o.is_main_repo ?? 0,
    archived: o.archived ?? 0,
    status: o.status ?? 'completed',
    last_viewed_at: o.last_viewed_at === undefined ? null : o.last_viewed_at,
    updated_at: o.updated_at ?? iso(10),
    chat_run_id: o.chat_run_id === undefined ? 'run-s1' : o.chat_run_id,
  };
  // Seed the FK target so chat_run_id resolves through the LEFT JOIN, unless the
  // test is exercising a dangling chat_run_id (seedRun: false).
  if (s.chat_run_id && o.seedRun !== false) {
    db.prepare(`INSERT OR IGNORE INTO workflow_runs (id) VALUES (?)`).run(s.chat_run_id);
  }
  db.prepare(
    `INSERT INTO sessions
       (id, name, project_id, substrate, is_quick, is_main_repo, archived, status,
        last_viewed_at, updated_at, chat_run_id)
     VALUES (@id,@name,@project_id,@substrate,@is_quick,@is_main_repo,@archived,@status,
             @last_viewed_at,@updated_at,@chat_run_id)`,
  ).run(s);
  return s.id;
}

// ---------------------------------------------------------------------------
// applyReviewItem spy — records calls AND writes minimal rows to review_items
// so the detector's own SELECTs (idempotency + auto-resolve) see the effect.
// ---------------------------------------------------------------------------

function makeApply(db: Database.Database) {
  const calls: Array<{ projectId: number; change: ReviewItemCreate | ReviewItemTriage }> = [];
  let seq = 0;
  const apply = async (projectId: number, change: ReviewItemCreate | ReviewItemTriage) => {
    calls.push({ projectId, change });
    seq += 1;
    if (change.op === 'create') {
      const id = `rvw_${seq}`;
      // created_at = NOW (mint happens well after the session's past updated_at),
      // which is what the detector's per-episode NOT EXISTS guard keys on.
      db.prepare(
        `INSERT INTO review_items (id, project_id, kind, status, source, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      ).run(id, projectId, change.kind, change.source ?? null, new Date(NOW_MS).toISOString());
      return { reviewItemId: id, event: { id: seq, seq } };
    }
    db.prepare(`UPDATE review_items SET status = 'resolved' WHERE id = ?`).run(change.reviewItemId);
    return { reviewItemId: change.reviewItemId, event: { id: seq, seq } };
  };
  return { apply, calls };
}

const enabledConfig = (): IdleSessionReviewSettings => ({ enabled: true, thresholdMinutes: 5 });

function makeDetector(
  db: Database.Database,
  apply: ReturnType<typeof makeApply>['apply'],
  getConfig: () => IdleSessionReviewSettings = enabledConfig,
) {
  return new IdleSessionDetector({
    db: dbAdapter(db),
    applyReviewItem: apply,
    getConfig,
    logger: makeSpyLogger(),
    now,
  });
}

const creates = (calls: Array<{ change: ReviewItemCreate | ReviewItemTriage }>) =>
  calls.filter((c) => c.change.op === 'create');
const resolves = (calls: Array<{ change: ReviewItemCreate | ReviewItemTriage }>) =>
  calls.filter((c) => c.change.op === 'resolve');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IdleSessionDetector — minting', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('mints a blocking human_task for an idle unviewed interactive quick session', async () => {
    seedSession(db);
    const { apply, calls } = makeApply(db);
    await makeDetector(db, apply).scan();

    const c = creates(calls);
    expect(c).toHaveLength(1);
    const change = c[0].change as ReviewItemCreate;
    expect(c[0]).toMatchObject({ projectId: 7 });
    expect(change).toMatchObject({
      op: 'create',
      actor: 'orchestrator',
      kind: 'human_task',
      blocking: true,
      source: 'idle-session:s1',
      runId: 'run-s1',
    });
    expect(change.payload).toEqual({ kind: 'human_task' });
    expect(change.title).toContain('quick-20260710-190000');
  });

  it('omits runId when the session has no chat_run_id', async () => {
    seedSession(db, { chat_run_id: null });
    const { apply, calls } = makeApply(db);
    await makeDetector(db, apply).scan();

    const change = creates(calls)[0].change as ReviewItemCreate;
    expect(change.runId).toBeUndefined();
  });

  it('omits runId (but still surfaces) when chat_run_id dangles with no workflow_runs row', async () => {
    // Dangling-FK guard: passing a pruned run id would throw on the real FK and
    // silently drop the session. The LEFT JOIN nulls the runId instead.
    seedSession(db, { chat_run_id: 'ghost-run', seedRun: false });
    const { apply, calls } = makeApply(db);
    await makeDetector(db, apply).scan();

    const c = creates(calls);
    expect(c).toHaveLength(1); // session still surfaced
    expect((c[0].change as ReviewItemCreate).runId).toBeUndefined();
  });

  it('does not double-mint across repeated scans (idempotent per session)', async () => {
    seedSession(db);
    const { apply, calls } = makeApply(db);
    const d = makeDetector(db, apply);
    await d.scan();
    await d.scan();
    await d.scan();
    expect(creates(calls)).toHaveLength(1);
  });

  it('does NOT re-mint after the item is resolved/dismissed without opening the session', async () => {
    // Finding: keying idempotency on status='pending' re-minted every tick once
    // the user cleared it. The per-episode guard keys on created_at >= updated_at,
    // so a triaged item still suppresses re-mint for the SAME idle episode.
    seedSession(db);
    const { apply, calls } = makeApply(db);
    const d = makeDetector(db, apply);
    await d.scan(); // mint
    expect(creates(calls)).toHaveLength(1);

    // User clears it from the queue but never opens the session.
    db.prepare(`UPDATE review_items SET status = 'resolved' WHERE source = 'idle-session:s1'`).run();
    await d.scan();
    await d.scan();
    expect(creates(calls)).toHaveLength(1); // no respawn
  });

  it('re-mints for a genuinely new idle episode (updated_at advances past the old item)', async () => {
    // An old, already-resolved idle item from a prior episode (created 20m ago).
    seedSession(db, { updated_at: iso(10) });
    db.prepare(
      `INSERT INTO review_items (id, project_id, kind, status, source, created_at)
       VALUES ('rvw_old', 7, 'human_task', 'resolved', 'idle-session:s1', ?)`,
    ).run(iso(20));
    const { apply, calls } = makeApply(db);
    await makeDetector(db, apply).scan();
    // updated_at (10m ago) is newer than the old item's created_at (20m ago) →
    // this is a fresh episode → surfaces again.
    expect(creates(calls)).toHaveLength(1);
  });
});

describe('IdleSessionDetector — threshold', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('does not surface a session that rested inside the threshold window', async () => {
    seedSession(db, { updated_at: iso(2) }); // 2 min < 5 min threshold
    const { apply, calls } = makeApply(db);
    await makeDetector(db, apply).scan();
    expect(creates(calls)).toHaveLength(0);
  });

  it('honors a larger configured threshold', async () => {
    seedSession(db, { updated_at: iso(10) }); // 10 min idle
    const { apply, calls } = makeApply(db);
    await makeDetector(db, apply, () => ({ enabled: true, thresholdMinutes: 15 })).scan();
    expect(creates(calls)).toHaveLength(0);
  });
});

describe('IdleSessionDetector — SQLite wire timestamp format', () => {
  // Guards the datetime()-normalized comparison. Under a naive lexicographic
  // `updated_at < cutoffIso`, the space-format column (' ' at index 10) always
  // sorts before the ISO cutoff ('T' at index 10), so EVERY same-day session —
  // even one that rested seconds ago — would falsely surface.
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('surfaces a genuinely-idle session stored in SQLite space format', async () => {
    seedSession(db, { updated_at: sqliteTs(10), last_viewed_at: null });
    const { apply, calls } = makeApply(db);
    await makeDetector(db, apply).scan();

    const c = creates(calls);
    expect(c).toHaveLength(1);
    // idleMin parsed as UTC (via the strftime-normalized column), not local time.
    expect((c[0].change as ReviewItemCreate).body).toContain('10 min');
  });

  it('does NOT surface a recently-rested space-format session (regression guard)', async () => {
    seedSession(db, { updated_at: sqliteTs(2), last_viewed_at: null }); // 2 min < 5
    const { apply, calls } = makeApply(db);
    await makeDetector(db, apply).scan();
    expect(creates(calls)).toHaveLength(0);
  });

  it('excludes a viewed space-format session (last_viewed_at after updated_at)', async () => {
    seedSession(db, { updated_at: sqliteTs(10), last_viewed_at: sqliteTs(0) });
    const { apply, calls } = makeApply(db);
    await makeDetector(db, apply).scan();
    expect(creates(calls)).toHaveLength(0);
  });
});

describe('IdleSessionDetector — scope exclusions', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  const cases: Array<[string, SeedSessionOverrides]> = [
    ['sdk substrate', { substrate: 'sdk' }],
    ['not a quick session', { is_quick: 0 }],
    ['hidden main-repo singleton', { is_main_repo: 1 }],
    ['archived', { archived: 1 }],
    ['still running', { status: 'running' }],
    ['viewed since the turn (last_viewed_at == updated_at)', { last_viewed_at: iso(10) }],
    ['viewed after the turn', { last_viewed_at: iso(1) }],
  ];

  for (const [label, overrides] of cases) {
    it(`skips: ${label}`, async () => {
      seedSession(db, overrides);
      const { apply, calls } = makeApply(db);
      await makeDetector(db, apply).scan();
      expect(creates(calls)).toHaveLength(0);
    });
  }
});

describe('IdleSessionDetector — auto-resolve', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('resolves the pending item once the session is viewed', async () => {
    seedSession(db);
    const { apply, calls } = makeApply(db);
    const d = makeDetector(db, apply);
    await d.scan(); // mint
    expect(creates(calls)).toHaveLength(1);

    // User opens the session: last_viewed_at moves past updated_at → out of scope.
    db.prepare(`UPDATE sessions SET last_viewed_at = ? WHERE id = 's1'`).run(iso(0));
    await d.scan();

    const r = resolves(calls);
    expect(r).toHaveLength(1);
    expect((r[0].change as ReviewItemTriage).resolution).toBe('idle-session-attended');
    const row = db.prepare(`SELECT status FROM review_items WHERE source = 'idle-session:s1'`).get() as { status: string };
    expect(row.status).toBe('resolved');
  });

  it('resolves the pending item when a new turn starts (status running)', async () => {
    seedSession(db);
    const { apply, calls } = makeApply(db);
    const d = makeDetector(db, apply);
    await d.scan();
    db.prepare(`UPDATE sessions SET status = 'running' WHERE id = 's1'`).run();
    await d.scan();
    expect(resolves(calls)).toHaveLength(1);
  });

  it('resolves the pending item when the session is archived', async () => {
    seedSession(db);
    const { apply, calls } = makeApply(db);
    const d = makeDetector(db, apply);
    await d.scan();
    db.prepare(`UPDATE sessions SET archived = 1 WHERE id = 's1'`).run();
    await d.scan();
    expect(resolves(calls)).toHaveLength(1);
  });

  it('keeps the item while the session stays idle+unviewed', async () => {
    seedSession(db);
    const { apply, calls } = makeApply(db);
    const d = makeDetector(db, apply);
    await d.scan();
    await d.scan();
    expect(resolves(calls)).toHaveLength(0);
  });
});

describe('IdleSessionDetector — disabled', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  const disabled = (): IdleSessionReviewSettings => ({ enabled: false, thresholdMinutes: 5 });

  it('does not mint when disabled', async () => {
    seedSession(db);
    const { apply, calls } = makeApply(db);
    await makeDetector(db, apply, disabled).scan();
    expect(creates(calls)).toHaveLength(0);
  });

  it('drains a still-idle outstanding item when flipped off (no view needed)', async () => {
    seedSession(db);
    const { apply, calls } = makeApply(db);
    // Mint while enabled — session is and stays idle+unviewed.
    await makeDetector(db, apply, enabledConfig).scan();
    expect(creates(calls)).toHaveLength(1);
    // Turn the feature off: the blocking item must clear even though the session
    // is still idle (turning it off = stop AND clear its nags).
    await makeDetector(db, apply, disabled).scan();
    expect(resolves(calls)).toHaveLength(1);
    const row = db.prepare(`SELECT status FROM review_items WHERE source = 'idle-session:s1'`).get() as { status: string };
    expect(row.status).toBe('resolved');
  });
});

describe('IdleSessionDetector — re-entrancy', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('a scan entered while another is in flight returns early (no overlap)', async () => {
    seedSession(db);
    // A gated apply: the first create hangs until we release it, so we can drive
    // a second scan() concurrently and prove the re-entrancy guard blocks it.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let creates = 0;
    const apply = async (_pid: number, change: ReviewItemCreate | ReviewItemTriage) => {
      if (change.op === 'create') { creates += 1; await gate; }
      return { reviewItemId: 'rvw_x', event: { id: 1, seq: 1 } };
    };
    const d = makeDetector(db, apply);

    const first = d.scan();            // enters, hangs inside the create
    await Promise.resolve();
    await d.scan();                    // guarded — returns immediately
    release();
    await first;
    expect(creates).toBe(1);
  });
});

describe('IdleSessionDetector — scheduling', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); db.close(); });

  it('fires scan on the 60s interval and stops on stop()', async () => {
    seedSession(db);
    const { apply, calls } = makeApply(db);
    const d = makeDetector(db, apply);

    d.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(creates(calls)).toHaveLength(1); // one mint (idempotent thereafter)

    d.stop();
    // Change the session so a running scan WOULD act, then confirm none fires.
    db.prepare(`DELETE FROM review_items`).run();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(creates(calls)).toHaveLength(1); // unchanged — interval cancelled
  });
});
