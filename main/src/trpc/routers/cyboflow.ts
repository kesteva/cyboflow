/**
 * cyboflow namespace router — review-queue-ui epic (TASK-401).
 *
 * Composes the approvals and events sub-routers under the `cyboflow` namespace
 * and exports the full AppRouter type.
 *
 * NOTE: The canonical AppRouter used by main/src/index.ts and the renderer's
 * tRPC client is defined in main/src/orchestrator/trpc/router.ts.  This file
 * establishes the review-queue-ui epic's contribution to that router shape and
 * is imported by the orchestrator router to include these sub-routers.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { router } from '../index';
import { approvalsRouter } from './approvals';
import { eventsRouter } from './events';

/** Scoped router exposing only the review-queue-ui procedures. */
export const cyboflowRouter = router({
  approvals: approvalsRouter,
  events: eventsRouter,
});

/** Root AppRouter — re-exported from shared/types/trpc for renderer consumption. */
export const appRouter = router({
  cyboflow: cyboflowRouter,
});

/** Inferred type of the full app router. */
export type AppRouter = typeof appRouter;
