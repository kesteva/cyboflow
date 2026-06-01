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
import { healthRouter } from './routers/health';
import { questionsRouter } from './routers/questions';
import { tasksRouter } from './routers/tasks';

export const appRouter = router({
  cyboflow: router({
    approvals: approvalsRouter,
    events: eventsRouter,
    health: healthRouter,
    questions: questionsRouter,
    runs: runsRouter,
    tasks: tasksRouter,
    workflows: workflowsRouter,
  }),
});

/** Inferred type of the full app router — re-exported from shared/types/trpc.ts
 *  so the frontend can import it without a direct main/ dependency. */
export type AppRouter = typeof appRouter;
