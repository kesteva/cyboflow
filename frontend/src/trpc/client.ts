/**
 * Renderer-side tRPC client — re-export from the canonical location.
 *
 * The canonical typed tRPC client is defined at
 * `frontend/src/utils/trpcClient.ts`.  This module re-exports it so that
 * code following the review-queue-ui epic's import path
 * (`../trpc/client`) resolves to the same singleton as the existing
 * codebase (`../utils/trpcClient`).
 *
 * A single client instance is essential for tRPC v11 — creating two
 * `createTRPCProxyClient` calls would register duplicate IPC listeners and
 * break subscriptions.
 *
 * Import in stores and components:
 *   import { trpc } from '@/trpc/client';        // review-queue-ui convention
 *   import { trpc } from '@/utils/trpcClient';   // existing codebase convention
 * Both resolve to the same object.
 */
export { trpc } from '../utils/trpcClient';
