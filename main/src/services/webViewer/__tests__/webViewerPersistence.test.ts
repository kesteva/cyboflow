/**
 * PersistingWebViewer — the web viewer's DB side over a real (in-memory) schema
 * and a fake manager. docs/proposals/native-web-viewer.md §5.
 */
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebTabsRepository } from '../../../database/webTabsRepository';
import type { WebTabSnapshot } from '../../../../../shared/types/webViewer';
import type { WebViewerOpenArgs } from '../../../orchestrator/trpc/contracts/webViewerOps';

vi.mock('electron', () => ({}));

import { PersistingWebViewer } from '../webViewerPersistence';
import { WEB_VIEWER_HUMAN_TOUCH, WEB_VIEWER_TAB_CLOSED, WEB_VIEWER_TAB_STATE } from '../webViewerManager';

const SQL = readFileSync(
  join(__dirname, '..', '..', '..', 'database', 'migrations', '147_session_web_tabs.sql'),
  'utf-8',
);

function snap(tabId: string, over: Partial<WebTabSnapshot> = {}): WebTabSnapshot {
  return {
    tabId,
    sessionId: 's1',
    state: 'hidden',
    currentUrl: 'https://example.com/a?token=SECRET',
    title: null,
    openedBy: 'user',
    openedByRunId: null,
    humanTouched: false,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    blockedReason: null,
    ...over,
  };
}

class FakeManager extends EventEmitter {
  tabs = new Map<string, WebTabSnapshot>();
  opens: WebViewerOpenArgs[] = [];
  disposed: string[] = [];
  async open(args: WebViewerOpenArgs) {
    this.opens.push(args);
    const s = snap(args.tabId, {
      currentUrl: args.url,
      openedBy: args.openedBy,
      title: args.restore?.title ?? null,
      humanTouched: args.restore?.humanTouched ?? false,
      state: args.deferLoad ? 'evicted' : 'hidden',
    });
    this.tabs.set(args.tabId, s);
    return { ok: true as const, snapshot: s };
  }
  async close(tabId: string) {
    return this.tabs.delete(tabId) ? { ok: true as const } : { ok: false as const, error: 'tab_not_found' };
  }
  async get(tabId: string) {
    return this.tabs.get(tabId) ?? null;
  }
  async list() {
    return [...this.tabs.values()];
  }
  disposeSession(sessionId: string) {
    this.disposed.push(sessionId);
    for (const [id, s] of this.tabs) if (s.sessionId === sessionId) this.tabs.delete(id);
  }
  tabIdsForSession(sessionId: string) {
    return [...this.tabs.values()].filter((s) => s.sessionId === sessionId).map((s) => s.tabId);
  }
  navigate = vi.fn();
  back = vi.fn();
  forward = vi.fn();
  reload = vi.fn();
  setBounds = vi.fn();
  setVisible = vi.fn();
}

let db: Database.Database;
let repo: WebTabsRepository;
let manager: FakeManager;
let viewer: PersistingWebViewer;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY);`);
  db.prepare(`INSERT INTO sessions (id) VALUES ('s1')`).run();
  db.exec(SQL);
  repo = new WebTabsRepository(db);
  manager = new FakeManager();
  viewer = new PersistingWebViewer(manager as never, repo);
});

const openArgs = (tabId: string): WebViewerOpenArgs => ({
  sessionId: 's1',
  tabId,
  url: 'https://example.com/a?token=SECRET',
  openedBy: 'user',
});

describe('PersistingWebViewer', () => {
  it('persists a row on open and audits it with the REDACTED origin only', async () => {
    await viewer.open(openArgs('web:1'));
    expect(repo.listTabs('s1').map((t) => t.id)).toEqual(['web:1']);
    const [ev] = repo.listEvents('s1');
    expect(ev).toMatchObject({ kind: 'tab_opened', tabId: 'web:1', origin: 'https://example.com' });
    // No full URL anywhere in the audit trail — the query is where tokens live.
    expect(JSON.stringify(repo.listEvents('s1'))).not.toContain('SECRET');
  });

  it('follows navigation and title changes, but writes nothing for a no-op state event', async () => {
    await viewer.open(openArgs('web:1'));
    const update = vi.spyOn(repo, 'updateTab');
    manager.emit(WEB_VIEWER_TAB_STATE, { sessionId: 's1', snapshot: snap('web:1', { loading: true }) });
    expect(update).not.toHaveBeenCalled();
    manager.emit(WEB_VIEWER_TAB_STATE, {
      sessionId: 's1',
      snapshot: snap('web:1', { currentUrl: 'https://example.com/b', title: 'B' }),
    });
    expect(repo.getTab('web:1')).toMatchObject({ currentUrl: 'https://example.com/b', title: 'B' });
  });

  it('persists the human-touch latch the moment it fires', async () => {
    await viewer.open(openArgs('web:1'));
    manager.emit(WEB_VIEWER_HUMAN_TOUCH, { sessionId: 's1', tabId: 'web:1' });
    expect(repo.getTab('web:1')?.humanTouched).toBe(true);
    expect(repo.listEvents('s1').map((e) => e.kind)).toContain('human_touched');
  });

  it('deletes the row on an explicit close, and audits it', async () => {
    await viewer.open(openArgs('web:1'));
    await viewer.close('web:1');
    expect(repo.listTabs('s1')).toEqual([]);
    expect(repo.listEvents('s1')[0].kind).toBe('tab_closed');
  });

  it('audits an eviction transition once, and a crash', async () => {
    await viewer.open(openArgs('web:1'));
    manager.emit(WEB_VIEWER_TAB_STATE, { sessionId: 's1', snapshot: snap('web:1') });
    manager.emit(WEB_VIEWER_TAB_STATE, { sessionId: 's1', snapshot: snap('web:1', { state: 'evicted' }) });
    manager.emit(WEB_VIEWER_TAB_STATE, { sessionId: 's1', snapshot: snap('web:1', { state: 'evicted' }) });
    manager.emit(WEB_VIEWER_TAB_CLOSED, { sessionId: 's1', tabId: 'web:1', reason: 'crashed' });
    const kinds = repo.listEvents('s1').map((e) => e.kind);
    expect(kinds.filter((k) => k === 'tab_evicted')).toHaveLength(1);
    expect(kinds).toContain('tab_crashed');
    // Eviction and crash keep the row: the tab comes back.
    expect(repo.listTabs('s1')).toHaveLength(1);
  });

  it('restores rows UNLOADED under their persisted ids, carrying human_touched back', async () => {
    repo.insertTab({
      id: 'web:old',
      sessionId: 's1',
      initialUrl: 'https://example.com/start',
      currentUrl: 'https://example.com/later',
      title: 'Later',
      openedBy: 'agent',
      openedByRunId: 'run-1',
    });
    repo.updateTab('web:old', { humanTouched: true });

    const restored = await viewer.restore('s1');
    expect(manager.opens[0]).toMatchObject({
      tabId: 'web:old',
      url: 'https://example.com/later',
      deferLoad: true,
      restore: { initialUrl: 'https://example.com/start', title: 'Later', humanTouched: true },
    });
    expect(restored).toEqual([
      expect.objectContaining({ tabId: 'web:old', humanTouched: true, title: 'Later', openedByRunId: 'run-1' }),
    ]);
    // A restore is not a new open: no second row, no tab_opened audit.
    expect(repo.listTabs('s1')).toHaveLength(1);
    expect(repo.listEvents('s1')).toEqual([]);
  });

  it('restore is idempotent — a remount does not re-open a tab the manager holds', async () => {
    repo.insertTab({ id: 'web:old', sessionId: 's1', initialUrl: 'https://example.com/', openedBy: 'user' });
    await viewer.restore('s1');
    await viewer.restore('s1');
    expect(manager.opens).toHaveLength(1);
  });

  it('session teardown destroys views, drops rows and KEEPS the audit trail', async () => {
    await viewer.open(openArgs('web:1'));
    viewer.disposeSession('s1');
    expect(manager.disposed).toEqual(['s1']);
    expect(repo.listTabs('s1')).toEqual([]);
    expect(repo.listEvents('s1').map((e) => e.kind)).toEqual(['session_disposed', 'tab_opened']);
  });

  it('never lets a failed write break an open', async () => {
    vi.spyOn(repo, 'insertTab').mockImplementation(() => {
      throw new Error('disk full');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await viewer.open(openArgs('web:1'))).ok).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
