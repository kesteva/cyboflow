/**
 * Root tRPC router — combines all cyboflow sub-routers under the
 * `cyboflow` namespace.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { router } from './trpc';
import { runsRouter } from './routers/runs';
import { approvalsRouter } from './routers/approvals';
import { workflowsRouter } from './routers/workflows';
import { eventsRouter } from './routers/events';

export const appRouter = router({
  cyboflow: router({
    runs: runsRouter,
    approvals: approvalsRouter,
    workflows: workflowsRouter,
    events: eventsRouter,
  }),
});

/** Inferred type of the full app router — re-exported from shared/types/trpc.ts
 *  so the frontend can import it without a direct main/ dependency. */
export type AppRouter = typeof appRouter;
