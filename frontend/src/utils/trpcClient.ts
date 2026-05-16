/**
 * Backwards-compatibility re-export shim.
 *
 * The canonical tRPC client is now at frontend/src/trpc/client.ts.
 * This module re-exports `trpc` so existing imports at `utils/trpcClient`
 * continue to work without modification.
 *
 * Do NOT add new exports here. Import from `@/trpc/client` in new code.
 */
export { trpc } from '../trpc/client';
