/**
 * WebViewerManager — suspension, caps, pins, crash recovery, focus hand-back.
 *
 * Electron is faked at the module boundary: a `WebContentsView` here is a plain
 * object whose `webContents` is an EventEmitter recording `loadURL` calls. What
 * is under test is the manager's bookkeeping — which views exist, which state it
 * reports, which URL a re-load goes to — not Chromium.
 * docs/proposals/native-web-viewer.md §3.4.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events') as typeof import('events');

  let nextId = 1;
  class FakeWebContents extends EventEmitter {
    id = nextId++;
    destroyed = false;
    focused = false;
    loads: string[] = [];
    reloads = 0;
    navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    loadURL(url: string): Promise<void> {
      this.loads.push(url);
      return Promise.resolve();
    }
    reload(): void {
      this.reloads += 1;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isFocused(): boolean {
      return this.focused;
    }
    close(): void {
      this.destroyed = true;
    }
    setWindowOpenHandler(): void {}
  }

  const created: FakeView[] = [];
  class FakeView {
    webContents = new FakeWebContents();
    bounds: unknown = null;
    visible = false;
    constructor() {
      created.push(this);
    }
    setBounds(b: unknown): void {
      this.bounds = b;
    }
    setVisible(v: boolean): void {
      this.visible = v;
    }
  }
  return { FakeView, created };
});
const created = fakes.created;

vi.mock('electron', () => ({
  WebContentsView: fakes.FakeView,
  shell: { openExternal: vi.fn() },
  session: {
    fromPartition: () => ({
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      on: vi.fn(),
      webRequest: { onSendHeaders: vi.fn(), onCompleted: vi.fn(), onErrorOccurred: vi.fn() },
    }),
  },
}));

import { WebViewerManager, WEB_VIEWER_TAB_STATE } from '../webViewerManager';
import { WEB_VIEWER_LIMITS } from '../webViewerGuard';
import { resetPartitionHardeningForTests } from '../webViewerPartitions';

function makeWindow() {
  const children = new Set<unknown>();
  return {
    children,
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: { getZoomFactor: () => 1, focus: vi.fn() },
    contentView: {
      addChildView: (v: unknown) => children.add(v),
      removeChildView: (v: unknown) => children.delete(v),
    },
  };
}

let clock = 1_000_000;
let win: ReturnType<typeof makeWindow>;
let manager: InstanceType<typeof WebViewerManager>;

beforeEach(() => {
  created.length = 0;
  clock = 1_000_000;
  resetPartitionHardeningForTests();
  win = makeWindow();
  manager = new WebViewerManager({
    getMainWindow: () => win as never,
    isEnabled: () => true,
    persistLogin: () => true,
    shortcutOverrides: () => undefined,
    devMode: false,
    platform: 'mac',
    now: () => clock,
  });
});

async function open(tabId: string, over: { sessionId?: string; openedBy?: 'user' | 'agent'; url?: string } = {}) {
  clock += 1;
  return manager.open({
    sessionId: over.sessionId ?? 's1',
    tabId,
    url: over.url ?? `https://example.com/${tabId}`,
    openedBy: over.openedBy ?? 'user',
  });
}

describe('suspension', () => {
  it('hiding a tab detaches the view but keeps it loaded and NEVER changes its committed URL', async () => {
    await open('t1');
    await manager.setVisible('t1', true);
    created[0].webContents.emit('did-navigate', {}, 'https://example.com/t1/deep?q=1');
    await manager.setVisible('t1', false);

    const snap = await manager.get('t1');
    expect(snap?.state).toBe('hidden');
    expect(snap?.currentUrl).toBe('https://example.com/t1/deep?q=1');
    expect(created[0].webContents.isDestroyed()).toBe(false);
    expect(win.children.has(created[0])).toBe(false);
    // Only the initial load — suspension never navigated anywhere (no about:blank).
    expect(created[0].webContents.loads).toEqual(['https://example.com/t1']);
  });

  it('hands keyboard focus back to the app when it detaches a focused view', async () => {
    await open('t1');
    await manager.setVisible('t1', true);
    created[0].webContents.focused = true;
    await manager.setVisible('t1', false);
    expect(win.webContents.focus).toHaveBeenCalledTimes(1);
  });
});

describe('hard caps', () => {
  it(`rejects the open past maxTabs (${WEB_VIEWER_LIMITS.maxTabs}) and creates no row`, async () => {
    // Every open after the first few is evicted; the ROW count is what caps.
    for (let i = 0; i < WEB_VIEWER_LIMITS.maxTabs; i += 1) {
      expect((await open(`t${i}`)).ok).toBe(true);
    }
    const res = await open('one-too-many');
    expect(res).toEqual({ ok: false, error: 'tab_limit_reached' });
    expect(await manager.get('one-too-many')).toBeNull();
  });

  it('keeps the cap per session: another session can still open', async () => {
    for (let i = 0; i < WEB_VIEWER_LIMITS.maxTabs; i += 1) await open(`t${i}`);
    expect((await open('other', { sessionId: 's2' })).ok).toBe(true);
  });

  it('rate-limits agent opens', async () => {
    for (let i = 0; i < WEB_VIEWER_LIMITS.agentOpenBurst; i += 1) {
      expect((await open(`a${i}`, { openedBy: 'agent' })).ok).toBe(true);
    }
    expect(await open('burst', { openedBy: 'agent' })).toEqual({ ok: false, error: 'rate_limited' });
    // The window slides.
    clock += WEB_VIEWER_LIMITS.agentOpenWindowMs;
    expect((await open('later', { openedBy: 'agent' })).ok).toBe(true);
  });

  it('LRU-destroys past maxLoadedViews, REPORTS it, and re-navigates to the committed URL on demand', async () => {
    const states: Array<{ tabId: string; state: string }> = [];
    manager.on(WEB_VIEWER_TAB_STATE, (ev: { snapshot: { tabId: string; state: string } }) =>
      states.push({ tabId: ev.snapshot.tabId, state: ev.snapshot.state }),
    );
    await open('t0');
    created[0].webContents.emit('did-navigate', {}, 'https://example.com/t0/after-click');
    for (let i = 1; i <= WEB_VIEWER_LIMITS.maxLoadedViews; i += 1) await open(`t${i}`);

    // t0 is the LRU and the one over the cap.
    expect(created[0].webContents.isDestroyed()).toBe(true);
    expect((await manager.get('t0'))?.state).toBe('evicted');
    expect(states).toContainEqual({ tabId: 't0', state: 'evicted' });
    expect((await manager.get('t0'))?.currentUrl).toBe('https://example.com/t0/after-click');

    await manager.setVisible('t0', true);
    const revived = created[created.length - 1];
    expect(revived).not.toBe(created[0]);
    expect(revived.webContents.loads).toEqual(['https://example.com/t0/after-click']);
    expect((await manager.get('t0'))?.state).toBe('live');
  });

  it('never evicts the visible tab', async () => {
    await open('shown');
    await manager.setVisible('shown', true);
    for (let i = 0; i < WEB_VIEWER_LIMITS.maxLoadedViews + 2; i += 1) await open(`t${i}`);
    expect((await manager.get('shown'))?.state).toBe('live');
  });

  it('an agent read pins a human tab over an unread one of the same age', async () => {
    await open('read');
    await open('unread');
    manager.noteAgentRead('read');
    // 'read' is OLDER than 'unread', so without the pin it would go first.
    for (let i = 0; i < WEB_VIEWER_LIMITS.maxLoadedViews - 1; i += 1) await open(`t${i}`);
    expect((await manager.get('unread'))?.state).toBe('evicted');
    expect((await manager.get('read'))?.state).toBe('hidden');
  });
});

describe('crash', () => {
  it('reports crashed, and recovers on reload with a FRESH view', async () => {
    await open('t1');
    created[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect((await manager.get('t1'))?.state).toBe('crashed');

    await manager.reload('t1');
    expect(created).toHaveLength(2);
    expect(created[0].webContents.isDestroyed()).toBe(true);
    expect((await manager.get('t1'))?.state).not.toBe('crashed');
  });
});

describe('telemetry wiring', () => {
  it('records console output and navigation for the tab, and keeps it across an eviction', async () => {
    await open('t0');
    const wc = created[0].webContents;
    wc.emit('console-message', {
      level: 'error',
      message: 'boom',
      lineNumber: 3,
      sourceId: 'https://example.com/app.js',
      frame: { url: 'https://example.com/t0' },
    });
    wc.emit('did-navigate', {}, 'https://example.com/t0/next');
    expect(manager.telemetry.read('t0', 'console')!.entries[0]).toMatchObject({ level: 'error', message: 'boom' });
    expect(manager.telemetry.read('t0', 'navigation')!.entries.map((e) => e.kind)).toEqual(['commit']);

    for (let i = 1; i <= WEB_VIEWER_LIMITS.maxLoadedViews; i += 1) await open(`t${i}`);
    expect((await manager.get('t0'))?.state).toBe('evicted');
    // An evicted tab keeps its history — that is what an agent reads it for.
    expect(manager.telemetry.read('t0', 'console')!.entries).toHaveLength(1);
  });

  it('forgets a closed tab’s telemetry', async () => {
    await open('t0');
    created[0].webContents.emit('console-message', { level: 'info', message: 'x', lineNumber: 1, sourceId: '' });
    await manager.close('t0');
    expect(manager.telemetry.read('t0', 'console')).toBeNull();
  });

  it('survives a console message from a frame that is already gone', async () => {
    await open('t0');
    const gone = {
      get url(): string {
        throw new Error('Render frame was disposed');
      },
    };
    created[0].webContents.emit('console-message', { level: 'warning', message: 'late', lineNumber: 1, sourceId: '', frame: gone });
    expect(manager.telemetry.read('t0', 'console')!.entries[0]).toMatchObject({ message: 'late', frameUrl: null });
  });
});
