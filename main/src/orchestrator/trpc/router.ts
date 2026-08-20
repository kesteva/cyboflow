/**
 * Root tRPC router — combines all cyboflow sub-routers under the
 * `cyboflow` namespace.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { router } from './trpc';
import { agentThreadRouter } from './routers/agentThread';
import { agentsRouter } from './routers/agents';
import { designRouter } from './routers/design';
import { runsRouter } from './routers/runs';
import { approvalsRouter } from './routers/approvals';
import { workflowsRouter } from './routers/workflows';
import { dynamicWorkflowsRouter } from './routers/dynamicWorkflows';
import { eventsRouter } from './routers/events';
import { feedbackRouter } from './routers/feedback';
import { filesRouter } from './routers/files';
import { healthRouter } from './routers/health';
import { ideaComponentsRouter } from './routers/ideaComponents';
import { insightsRouter } from './routers/insights';
import { questionsRouter } from './routers/questions';
import { tasksRouter } from './routers/tasks';
import { trackerRouter } from './routers/tracker';
import { reviewItemsRouter } from './routers/reviewItems';
import { artifactsRouter } from './routers/artifacts';
import { substratesRouter } from './routers/substrates';
import { monitorRouter } from './routers/monitor';
import { mcpsRouter } from './routers/mcps';
import { pluginsRouter } from './routers/plugins';
import { variantsRouter } from './routers/variants';
import { experimentsRouter } from './routers/experiments';
import { verificationRequestsRouter } from './routers/verificationRequests';
import { ompRouter } from './routers/omp';
import { ompCommandRouter } from './routers/ompCommand';

export const appRouter = router({
  cyboflow: router({
    agentThread: agentThreadRouter,
    agents: agentsRouter,
    approvals: approvalsRouter,
    design: designRouter,
    artifacts: artifactsRouter,
    dynamicWorkflows: dynamicWorkflowsRouter,
    events: eventsRouter,
    experiments: experimentsRouter,
    feedback: feedbackRouter,
    files: filesRouter,
    health: healthRouter,
    ideaComponents: ideaComponentsRouter,
    insights: insightsRouter,
    mcps: mcpsRouter,
    monitor: monitorRouter,
    plugins: pluginsRouter,
    questions: questionsRouter,
    reviewItems: reviewItemsRouter,
    runs: runsRouter,
    substrates: substratesRouter,
    tasks: tasksRouter,
    tracker: trackerRouter,
    variants: variantsRouter,
    verificationRequests: verificationRequestsRouter,
    workflows: workflowsRouter,
    omp: ompRouter,
    ompCommand: ompCommandRouter,
  }),
});

/** Inferred type of the full app router — re-exported from shared/types/trpc.ts
 *  so the frontend can import it without a direct main/ dependency. */
export type AppRouter = typeof appRouter;
