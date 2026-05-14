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

/**
 * Attach the tRPC IPC handler to the given BrowserWindow.
 *
 * Wraps `createIPCHandler` from trpc-electron, wiring the appRouter and
 * createContext so every renderer invocation on `window` is dispatched to the
 * correct tRPC procedure.
 *
 * trpc-electron's createIPCHandler expects an async createContext; we wrap the
 * synchronous factory so the type contract is satisfied without changing the
 * orchestrator's narrow context interface.
 *
 * Crystal's existing `ipcMain.handle` surface is unaffected — this call is
 * purely additive for `cyboflow.*` procedures.
 */
export function attachOrchestratorTrpc({
  window,
  router,
  createContext,
}: AttachOrchestratorTrpcOpts): void {
  createIPCHandler({
    router,
    windows: [window],
    createContext: () => Promise.resolve(createContext()),
  });
}
