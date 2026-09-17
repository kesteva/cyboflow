/**
 * Guards the cyboflow patch on trpc-electron@0.1.2's main-side handler
 * (patches/trpc-electron@0.1.2.patch): a SUBFRAME navigation must never abort
 * the main frame's subscriptions.
 *
 * Upstream aborts, on every non-same-document `did-start-navigation`, each
 * subscription whose key starts with `${webContentsId}-${frame.routingId}`.
 * Frame routing ids are only unique PER RENDERER PROCESS, so an out-of-process
 * iframe (a sandboxed custom-views widget frame, an artifact frame) can carry
 * the same routing id as the window's main frame — and its navigation then
 * silently ended every live-tail subscription in the app (the assistant rail
 * stopped rendering replies and proposals until the window was reloaded).
 * The patch (a) ignores subframe navigations outright and (b) matches a
 * frame-scoped cleanup on the exact `${wc}-${frame}:` segment.
 *
 * Runs the REAL patched package (the CJS build that ships in the app) with
 * `electron` stubbed at require-time, so the behavior is asserted on what
 * ships, not on a re-implementation. The dist module is evaluated by hand
 * rather than imported because vitest externalizes node_modules — a
 * `vi.mock('electron')` never reaches it. Deliberately imports nothing from
 * 'electron' itself (the standalone-typecheck invariant of this directory).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { initTRPC } from '@trpc/server';

type IpcListener = (event: unknown, message: unknown) => void;
const ipcListeners: IpcListener[] = [];

const electronStub = {
  ipcMain: {
    on: (_channel: string, listener: IpcListener) => {
      ipcListeners.push(listener);
    },
  },
  ipcRenderer: { send: vi.fn(), on: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
};

type CreateIPCHandler = (opts: { router: unknown; windows: unknown[] }) => unknown;

/** Evaluate node_modules/trpc-electron/dist/main.cjs with `electron` stubbed. */
function loadPatchedTrpcElectron(): { createIPCHandler: CreateIPCHandler } {
  // Anchored on the package's own directory (CJS `__dirname` is unavailable
  // under vitest's ESM transform; `import.meta` fails main's CJS typecheck).
  const require = createRequire(join(process.cwd(), 'package.json'));
  const distPath = require.resolve('trpc-electron/main');
  const source = readFileSync(distPath, 'utf8');
  const module = { exports: {} as { createIPCHandler: CreateIPCHandler } };
  const stubbedRequire = (id: string): unknown => (id === 'electron' ? electronStub : require(id));
  new Function('require', 'module', 'exports', source)(stubbedRequire, module, module.exports);
  return module.exports;
}

const { createIPCHandler } = loadPatchedTrpcElectron();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const t = initTRPC.create();

/** One never-ending subscription; `emitter` is how a test pushes values. */
function makeRouter(emitter: EventEmitter) {
  return t.router({
    tick: t.procedure.subscription(async function* ({ signal }) {
      const queue: number[] = [];
      let wake: (() => void) | null = null;
      const onTick = (n: number): void => {
        queue.push(n);
        wake?.();
        wake = null;
      };
      emitter.on('tick', onTick);
      signal?.addEventListener('abort', () => {
        wake?.();
        wake = null;
      });
      try {
        while (signal?.aborted !== true) {
          if (queue.length > 0) {
            yield queue.shift() as number;
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      } finally {
        emitter.off('tick', onTick);
      }
    }),
  });
}

/** A BrowserWindow stand-in: just the webContents emitter trpc-electron listens on. */
function makeWindow(webContentsId: number) {
  const webContents = Object.assign(new EventEmitter(), { id: webContentsId });
  return { webContents, isDestroyed: () => false };
}

/** The ipcMain event shape trpc-electron reads: sender id, sender frame, reply(). */
function makeIpcEvent(webContentsId: number, routingId: number) {
  const replies: Array<{ id: number; result?: { type: string }; error?: unknown }> = [];
  return {
    replies,
    event: {
      sender: { id: webContentsId, isDestroyed: () => false },
      senderFrame: { routingId },
      reply: (_channel: string, message: { id: number; result?: { type: string }; error?: unknown }) => {
        replies.push(message);
      },
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  ipcListeners.length = 0;
});

// ---------------------------------------------------------------------------

describe('trpc-electron patch: did-start-navigation cleanup', () => {
  const WC = 7;
  const MAIN_FRAME = 12;

  async function openSubscription() {
    const emitter = new EventEmitter();
    const win = makeWindow(WC);
    createIPCHandler({ router: makeRouter(emitter), windows: [win] });
    expect(ipcListeners).toHaveLength(1);
    const { event, replies } = makeIpcEvent(WC, MAIN_FRAME);
    ipcListeners[0](event, {
      method: 'request',
      operation: { id: 3, type: 'subscription', path: 'tick', input: undefined, context: {} },
    });
    await flush();
    expect(replies.map((r) => r.result?.type)).toEqual(['started']);
    return { emitter, win, replies };
  }

  const dataTypes = (replies: Array<{ result?: { type: string } }>): string[] =>
    replies.map((r) => r.result?.type ?? 'error');

  it('a SUBFRAME navigation whose routing id equals the main frame\'s leaves the subscription alive', async () => {
    const { emitter, win, replies } = await openSubscription();

    // The out-of-process iframe case: same routing id as the main frame, in
    // another process. Upstream aborted the main frame's subscription here.
    win.webContents.emit('did-start-navigation', {
      isSameDocument: false,
      isMainFrame: false,
      frame: { routingId: MAIN_FRAME, processId: 99 },
      url: 'http://127.0.0.1:1234/widget/2',
    });
    await flush();
    expect(dataTypes(replies)).toEqual(['started']);

    // Still live: a value pushed after the subframe navigation is delivered.
    emitter.emit('tick', 42);
    await flush();
    expect(dataTypes(replies)).toEqual(['started', 'data']);
  });

  it('a subframe navigation with a routing id that PREFIXES the main frame\'s is ignored too', async () => {
    const { emitter, win, replies } = await openSubscription();
    // Key is `7-12:3`; upstream's bare `startsWith('7-1')` matched it. The
    // subframe guard alone already skips this; the exact `${wc}-${frame}:`
    // segment match is the second line of defense.
    win.webContents.emit('did-start-navigation', {
      isSameDocument: false,
      isMainFrame: false,
      frame: { routingId: 1 },
    });
    await flush();
    emitter.emit('tick', 1);
    await flush();
    expect(dataTypes(replies)).toEqual(['started', 'data']);
  });

  it('a MAIN-FRAME navigation still aborts the subscription (stopped, listener released)', async () => {
    const { emitter, win, replies } = await openSubscription();
    expect(emitter.listenerCount('tick')).toBe(1);

    win.webContents.emit('did-start-navigation', {
      isSameDocument: false,
      isMainFrame: true,
      frame: { routingId: MAIN_FRAME },
    });
    await flush();
    await flush();
    expect(dataTypes(replies)).toEqual(['started', 'stopped']);
    expect(emitter.listenerCount('tick')).toBe(0);
  });

  it('a same-document navigation (hash / pushState) changes nothing', async () => {
    const { emitter, win, replies } = await openSubscription();
    win.webContents.emit('did-start-navigation', {
      isSameDocument: true,
      isMainFrame: true,
      frame: { routingId: MAIN_FRAME },
    });
    await flush();
    emitter.emit('tick', 1);
    await flush();
    expect(dataTypes(replies)).toEqual(['started', 'data']);
  });

  it('webContents destruction still aborts every subscription of that window', async () => {
    const { emitter, win, replies } = await openSubscription();
    win.webContents.emit('destroyed');
    await flush();
    await flush();
    expect(dataTypes(replies)).toEqual(['started', 'stopped']);
    expect(emitter.listenerCount('tick')).toBe(0);
  });
});
