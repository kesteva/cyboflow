/**
 * SessionManager.convertDbSessionToSession — the sidebar's activity clock.
 *
 * The sidebar renders `session.lastActivity ?? session.createdAt` through a
 * "time ago" formatter (DraggableProjectTreeView). Two things had to be true
 * for that label to be correct, and neither was:
 *
 *   1. SOURCE — lastActivity came from `updated_at`, which any write to the row
 *      bumps. A rename, a folder move or the boot sweep made a long-quiet
 *      session read as active moments ago. It now prefers `idle_since`
 *      (migration 119), falling back to `updated_at` only while the session is
 *      busy and therefore has no rest boundary yet.
 *   2. PARSE — both columns are space-separated UTC, which `new Date()` reads
 *      as LOCAL. On any non-UTC host that shifted every timestamp into the
 *      future, and a negative interval collapses to the formatter's zero
 *      bucket — so the sidebar showed "just now" for everything.
 *
 * Mock-db harness mirrors sessionManagerArchive.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../panelManager', () => ({
  panelManager: { ensureDiffPanel: vi.fn(), getPanelsForSession: vi.fn().mockReturnValue([]) },
}));
vi.mock('../../ipc/logs', () => ({ addSessionLog: vi.fn(), cleanupSessionLogs: vi.fn() }));
import { SessionManager } from '../sessionManager';

type DbCtorArg = ConstructorParameters<typeof SessionManager>[0];

const CREATED = '2026-08-24 17:04:50';
const RESTED = '2026-08-24 19:00:00';
const BUMPED = '2026-08-24 19:12:52';

/** One db row, with only the columns the mapper reads. */
function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    name: 'smooth-falcon',
    worktree_path: '/tmp/w',
    initial_prompt: 'p',
    status: 'completed',
    created_at: CREATED,
    updated_at: BUMPED,
    idle_since: RESTED,
    ...overrides,
  };
}

function managerFor(row: Record<string, unknown>): SessionManager {
  const db = {
    getAllSessions: vi.fn().mockReturnValue([row]),
  };
  return new SessionManager(db as unknown as DbCtorArg);
}

function utc(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

describe('lastActivity source', () => {
  it('prefers idle_since over updated_at for a resting session', () => {
    const [session] = managerFor(dbRow()).getAllSessions();
    // 19:00 (the rest boundary), NOT 19:12:52 (the later incidental write).
    expect(session.lastActivity?.getTime()).toBe(utc(2026, 8, 24, 19, 0, 0));
  });

  it('falls back to updated_at when idle_since is null (a busy session)', () => {
    const [session] = managerFor(dbRow({ status: 'running', idle_since: null })).getAllSessions();
    expect(session.lastActivity?.getTime()).toBe(utc(2026, 8, 24, 19, 12, 52));
  });

  it('falls back to updated_at when idle_since is absent entirely', () => {
    const row = dbRow();
    delete (row as Record<string, unknown>).idle_since;
    const [session] = managerFor(row).getAllSessions();
    expect(session.lastActivity?.getTime()).toBe(utc(2026, 8, 24, 19, 12, 52));
  });
});

describe('timestamp parsing', () => {
  it('reads space-separated SQLite columns as UTC, not local', () => {
    const [session] = managerFor(dbRow()).getAllSessions();
    expect(session.lastActivity?.getTime()).toBe(utc(2026, 8, 24, 19, 0, 0));
    expect(session.createdAt.getTime()).toBe(utc(2026, 8, 24, 17, 4, 50));
  });

  it('never places a past timestamp in the future (the "just now" collapse)', () => {
    // The observable symptom: a session that rested minutes ago parsed as LOCAL
    // lands ahead of now on a UTC-behind host, the interval goes negative, and
    // the sidebar formatter reports its zero bucket for every recent row.
    const restedTenMinAgo = new Date(Date.now() - 10 * 60_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const [session] = managerFor(
      dbRow({ idle_since: restedTenMinAgo, updated_at: restedTenMinAgo }),
    ).getAllSessions();

    const elapsedMs = Date.now() - (session.lastActivity?.getTime() ?? 0);
    expect(elapsedMs).toBeGreaterThan(9 * 60_000);
    expect(elapsedMs).toBeLessThan(11 * 60_000);
  });

  it('still handles an already-zoned ISO value', () => {
    const [session] = managerFor(
      dbRow({ idle_since: '2026-08-24T19:00:00Z', created_at: '2026-08-24T17:04:50Z' }),
    ).getAllSessions();
    expect(session.lastActivity?.getTime()).toBe(utc(2026, 8, 24, 19, 0, 0));
    expect(session.createdAt.getTime()).toBe(utc(2026, 8, 24, 17, 4, 50));
  });
});
