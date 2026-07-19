/**
 * Unit tests for ipcAdapter.ts.
 *
 * Verifies that attachOrchestratorTrpc:
 *  - forwards router, createContext, and the BrowserWindow to trpc-electron's
 *    createIPCHandler with the correct shape on the FIRST call, and
 *  - upholds the single-handler invariant: a SECOND call does NOT create a
 *    second handler (which would register a duplicate global ipcMain listener
 *    and double-execute every request) — it only attachWindow()s the retained
 *    handler.
 *
 * trpc-electron/main is mocked so the test remains electron-free (no real IPC
 * channel is opened — the adapter's wiring is the only thing asserted).
 *
 * NOTE: this file intentionally avoids importing from 'electron' (even as a
 * type-only import) to maintain the standalone-typecheck invariant that only
 * ipcAdapter.ts itself may import from 'electron' under this directory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock trpc-electron/main before importing the adapter
// ---------------------------------------------------------------------------

// vi.mock is hoisted to top of file — factory must not reference variables
// declared outside the factory. Return a fresh handler (with a spied
// attachWindow) per createIPCHandler call so the adapter can retain + reuse it.
vi.mock('trpc-electron/main', () => ({
  createIPCHandler: vi.fn(() => ({ attachWindow: vi.fn(), detachWindow: vi.fn() })),
  exposeElectronTRPC: vi.fn(),
}));

// electron must also be mocked so ipcAdapter.ts can import BrowserWindow type
// without a real Electron environment. Only the type is used at runtime
// (the BrowserWindow value is passed in by the caller), so an empty stub is
// sufficient.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: {},
  ipcMain: { handle: vi.fn() },
}));

// Import after mocks are registered
import {
  attachOrchestratorTrpc,
  __resetOrchestratorTrpcHandlerForTests,
  type AttachOrchestratorTrpcOpts,
} from '../ipcAdapter';
import { appRouter } from '../router';
import { createContext } from '../context';
import * as trpcElectronMain from 'trpc-electron/main';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal BrowserWindow stub — only the reference identity matters for wiring tests. */
type FakeBrowserWindow = AttachOrchestratorTrpcOpts['window'];

/** Shape of the mocked handler createIPCHandler returns. */
type MockHandler = { attachWindow: ReturnType<typeof vi.fn> };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('attachOrchestratorTrpc', () => {
  const mockCreateIPCHandler = vi.mocked(trpcElectronMain.createIPCHandler);

  beforeEach(() => {
    mockCreateIPCHandler.mockClear();
    // Each case starts with no retained handler.
    __resetOrchestratorTrpcHandlerForTests();
  });

  it('attaches router and createContext via createIPCHandler', async () => {
    // Use a minimal stub — we only verify wiring, not real Electron behaviour
    const fakeBrowserWindow = {} as FakeBrowserWindow;

    attachOrchestratorTrpc({
      window: fakeBrowserWindow,
      router: appRouter,
      createContext,
    });

    expect(mockCreateIPCHandler).toHaveBeenCalledTimes(1);

    const call = mockCreateIPCHandler.mock.calls[0][0];
    // router and windows are passed through directly
    expect(call.router).toBe(appRouter);
    expect(call.windows).toEqual([fakeBrowserWindow]);
    // createContext is wrapped in Promise.resolve — verify it resolves to the
    // same shape as the original createContext(). The wrapper ignores the
    // IpcMainInvokeEvent arg so we pass an empty stub via unknown cast.
    expect(call.createContext).toBeDefined();
    const fakeEvent = {} as Parameters<NonNullable<typeof call.createContext>>[0];
    const ctx = await call.createContext!(fakeEvent);
    // Check shape rather than deep equality: setDockBadge is a callback
    // (function reference) that differs per createContext() invocation, so
    // toEqual would fail on function identity. Assert the scalar fields match
    // and that setDockBadge is present and callable.
    const expected = createContext();
    expect(ctx.userId).toBe(expected.userId);
    expect(typeof ctx.setDockBadge).toBe('function');
  });

  it('creates the handler exactly once and only attachWindow()s later windows', () => {
    const win1 = {} as FakeBrowserWindow;
    const win2 = {} as FakeBrowserWindow;

    attachOrchestratorTrpc({ window: win1, router: appRouter, createContext });
    attachOrchestratorTrpc({ window: win2, router: appRouter, createContext });

    // Single-handler invariant: createIPCHandler runs ONCE. A second call would
    // register a duplicate global ipcMain listener and double-execute mutations.
    expect(mockCreateIPCHandler).toHaveBeenCalledTimes(1);
    expect(mockCreateIPCHandler.mock.calls[0][0].windows).toEqual([win1]);

    // The second window is bound via attachWindow on the retained handler.
    const handler = mockCreateIPCHandler.mock.results[0].value as MockHandler;
    expect(handler.attachWindow).toHaveBeenCalledTimes(1);
    expect(handler.attachWindow).toHaveBeenCalledWith(win2);
  });
});
