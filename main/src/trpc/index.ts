/**
 * WARNING: DO NOT ADD NEW ROUTERS HERE.
 *
 * This directory (main/src/trpc/) is an orphan subtree that exists only to
 * host approveRestOfRunHandler until the approval-router epic wires ctx.db in
 * the orchestrator and allows it to take over.  The canonical live-router
 * location is main/src/orchestrator/trpc/routers/.  Any new router MUST go
 * there, not here.  Once the approval-router epic lands, this subtree will be
 * collapsed into the orchestrator tree and this directory will be deleted.
 *
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
