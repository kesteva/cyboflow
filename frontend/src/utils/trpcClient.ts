/**
 * Renderer-side tRPC client — typed against AppRouter from shared/types/trpc.
 *
 * Uses trpc-electron's ipcLink so all calls go through Electron's contextBridge
 * (the exposeElectronTRPC() call in preload.ts registers the channel). The
 * superjson transformer must match the server-side transformer in
 * main/src/orchestrator/trpc/trpc.ts.
 *
 * Import this singleton wherever tRPC procedures are needed in the renderer:
 *   import { trpc } from '@/utils/trpcClient';
 *   const result = await trpc.cyboflow.runs.list.query({});
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
