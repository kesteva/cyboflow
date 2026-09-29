/**
 * webTabsRepository — tab rows and the web audit trail (migration 147).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebTabsRepository } from '../webTabsRepository';

const SQL = readFileSync(join(__dirname, '..', 'migrations', '147_session_web_tabs.sql'), 'utf-8');

let db: Database.Database;
let repo: WebTabsRepository;
let clock = Date.parse('2026-09-25T10:00:00.000Z');

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY);`);
  db.prepare(`INSERT INTO sessions (id) VALUES ('s1'), ('s2')`).run();
  db.exec(SQL);
  clock = Date.parse('2026-09-25T10:00:00.000Z');
  repo = new WebTabsRepository(db, () => clock);
});

const tab = (id: string, sessionId = 's1') => ({
  id,
  sessionId,
  initialUrl: `https://example.com/${id}`,
  openedBy: 'user' as const,
});

describe('WebTabsRepository tabs', () => {
  it('appends tabs in per-session position order', () => {
    repo.insertTab(tab('a'));
    repo.insertTab(tab('b'));
    repo.insertTab(tab('x', 's2'));
    repo.insertTab(tab('c'));
    expect(repo.listTabs('s1').map((t) => [t.id, t.position])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    expect(repo.listTabs('s2').map((t) => t.position)).toEqual([0]);
  });

  it('treats a repeat insert of the same id as a no-op', () => {
    expect(repo.insertTab(tab('a'))).toBe(true);
    expect(repo.insertTab(tab('a'))).toBe(false);
    expect(repo.listTabs('s1')).toHaveLength(1);
  });

  it('writes nothing — and does not throw — for a key that is not a session row', () => {
    // The run pane keys its tabs by run id when a run has no parent session.
    expect(repo.insertTab(tab('a', 'run-123'))).toBe(false);
    expect(repo.appendEvent({ sessionId: 'run-123', kind: 'tab_opened' })).toBe(false);
  });

  it('stamps zoned ISO timestamps (never an unzoned SQLite datetime)', () => {
    repo.insertTab(tab('a'));
    expect(repo.getTab('a')?.createdAt).toBe('2026-09-25T10:00:00.000Z');
  });

  it('latches human_touched — a later false never clears it', () => {
    repo.insertTab(tab('a'));
    repo.updateTab('a', { humanTouched: true });
    repo.updateTab('a', { humanTouched: false, title: 'T' });
    expect(repo.getTab('a')).toMatchObject({ humanTouched: true, title: 'T' });
  });

  it('session teardown drops the tab rows but KEEPS the audit trail', () => {
    repo.insertTab(tab('a'));
    repo.appendEvent({ sessionId: 's1', tabId: 'a', kind: 'tab_opened', origin: 'https://example.com' });
    expect(repo.deleteTabsForSession('s1')).toBe(1);
    expect(repo.listTabs('s1')).toEqual([]);
    expect(repo.listEvents('s1')).toHaveLength(1);
  });
});

describe('WebTabsRepository audit', () => {
  it('lists newest first', () => {
    repo.appendEvent({ sessionId: 's1', kind: 'tab_opened' });
    clock += 1000;
    repo.appendEvent({ sessionId: 's1', kind: 'tab_closed' });
    expect(repo.listEvents('s1').map((e) => e.kind)).toEqual(['tab_closed', 'tab_opened']);
  });
});
