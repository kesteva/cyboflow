/**
 * IPC adapter — the ONLY file in main/src/orchestrator/trpc/ permitted to
 * import from 'electron'.
 *
 * Standalone-typecheck invariant: all other files under
 * main/src/orchestrator/trpc/ must remain electron-free so the orchestrator
 * subtree can be extracted to a standalone Node process for v2.
 *
 * See also: docs/ARCHITECTURE.md §Orchestrator, TASK-255.
 */
import { BrowserWindow } from 'electron';
import { createIPCHandler } from 'trpc-electron/main';
import type { AppRouter } from './router';
import type { Context } from './context';

export interface AttachOrchestratorTrpcOpts {
  window: BrowserWindow;
  router: AppRouter;
  createContext: () => Context;
}

/** The subset of trpc-electron's IPCHandler this adapter retains + reuses. */
type OrchestratorTrpcHandler = { attachWindow: (window: BrowserWindow) => void };

// trpc-electron's `createIPCHandler` registers a SINGLE GLOBAL `ipcMain` listener
// on construction — calling it twice would register a second listener and
// double-execute every renderer request (including mutations). So we build the
// handler EXACTLY ONCE for the process and retain it here; every subsequent
// window (e.g. the macOS 'activate' re-created window) is bound with
// `handler.attachWindow(win)` instead of a fresh `createIPCHandler`.
let retainedHandler: OrchestratorTrpcHandler | null = null;

/**
 * Bind the tRPC IPC handler to the given BrowserWindow.
 *
 * On the FIRST call it constructs the single global handler (wiring appRouter +
 * createContext) with this window attached; on every later call it only attaches
 * the window to the already-created handler. Callers therefore invoke this the
 * same way for the initial window and for any re-created window — the
 * single-handler invariant is enforced internally.
 *
 * trpc-electron's createIPCHandler expects an async createContext; we wrap the
 * synchronous factory so the type contract is satisfied without changing the
 * orchestrator's narrow context interface.
 *
 * Cyboflow's existing `ipcMain.handle` surface is unaffected — this call is
 * purely additive for `cyboflow.*` procedures.
 */
export function attachOrchestratorTrpc({
  window,
  router,
  createContext,
}: AttachOrchestratorTrpcOpts): void {
  if (retainedHandler) {
    retainedHandler.attachWindow(window);
    return;
  }
  retainedHandler = createIPCHandler({
    router,
    windows: [window],
    // TODO(v2): forward opts.event to createContext so procedures can read the
    // originating IpcMainInvokeEvent (e.g. for per-window auth-principal resolution).
    createContext: () => Promise.resolve(createContext()),
  });
}

/**
 * Test-only: drop the retained handler so each vitest case starts fresh. The
 * global ipcMain listener created by trpc-electron is left as-is (the tests mock
 * that module), so this only resets the adapter's single-handler bookkeeping.
 */
export function __resetOrchestratorTrpcHandlerForTests(): void {
  retainedHandler = null;
}
