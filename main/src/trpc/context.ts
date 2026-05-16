/**
 * tRPC context for cyboflow main/src/trpc routers.
 *
 * Re-exports the canonical context factory from the orchestrator sub-tree.
 * A single createContext implementation is shared across both router locations
 * so that auth-principal upgrade (v1 "local" → v2 real session token) is a
 * single-file change.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 *
 * @see main/src/orchestrator/trpc/context.ts for the implementation and
 * v2 team-tier upgrade notes.
 */
export { createContext } from '../orchestrator/trpc/context';
export type { Context } from '../orchestrator/trpc/context';
