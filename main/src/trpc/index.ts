/**
 * tRPC primitives for the cyboflow main process.
 *
 * Re-exports the canonical tRPC factory from the orchestrator sub-tree so that
 * all new routers in main/src/trpc/ can share a single initTRPC instance.
 * The orchestrator trpc.ts creates this instance with the superjson transformer
 * and the Context type — re-exporting ensures there is exactly ONE tRPC
 * instance across the entire main process (multiple instances would cause
 * runtime errors in tRPC v11).
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
export { router, publicProcedure, protectedProcedure } from '../orchestrator/trpc/trpc';
