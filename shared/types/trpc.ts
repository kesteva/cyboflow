/**
 * Re-export AppRouter so the frontend can import from `shared/types/trpc`
 * without crossing into main/ directly.
 *
 * Dependency direction: shared → main (type-only import), never
 * frontend → main directly.
 */
export type { AppRouter } from '../../main/src/orchestrator/trpc/router';
