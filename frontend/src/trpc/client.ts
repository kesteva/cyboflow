/**
 * Renderer-side tRPC client — canonical location.
 *
 * Typed against AppRouter (inferred from main/src/orchestrator/trpc/router.ts,
 * re-exported via shared/types/trpc.ts).
 *
 * Uses trpc-electron's ipcLink so all calls go through Electron's contextBridge
 * (the exposeElectronTRPC() call in preload.ts registers the channel). The
 * superjson transformer must match the server-side transformer in
 * main/src/orchestrator/trpc/trpc.ts.
 *
 * tRPC v11 subscription leak fix: pinned to trpc-electron@0.1.2 +
 * @trpc/server@^11.17.0 (stable v11 — includes PR #6161 fix).
 *
 * Symbol.asyncDispose clash fix (TASK-695): trpc-electron@0.1.2's main-process
 * makeAsyncResource threw when Node 22 already attached Symbol.asyncDispose to
 * async-generator iterators. Fixed via patches/trpc-electron@0.1.2.patch (pnpm
 * patch). NO renderer-side shim required — renderer's dist/renderer.mjs already
 * uses the safe nullish-fallback pattern.
 *
 * SINGLE SOURCE RULE: Do NOT create a second createTRPCProxyClient instance.
 * tRPC v11 subscriptions register IPC listeners per client instance — a second
 * instance causes duplicate event delivery. All renderer code must import
 * `trpc` from this module.
 *
 * Import:
 *   import { trpc } from '<relative>/trpc/client';
 */
import { createTRPCProxyClient } from '@trpc/client';
import { ipcLink } from 'trpc-electron/renderer';
import superjson from 'superjson';
import type { AppRouter } from '../../../shared/types/trpc';

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [
    ipcLink<AppRouter>({
      transformer: superjson,
    }),
  ],
});
