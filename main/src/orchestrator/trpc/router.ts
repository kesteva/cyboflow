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
import { customViewsRouter } from './routers/customViews';
import { customWidgetServerRouter } from './routers/customWidgetServer';
import { configRouter } from './routers/config';
import { designRouter } from './routers/design';
import { runsRouter } from './routers/runs';
import { approvalsRouter } from './routers/approvals';
import { workflowsRouter } from './routers/workflows';
import { dynamicWorkflowsRouter } from './routers/dynamicWorkflows';
import { eventsRouter } from './routers/events';
import { feedbackRouter } from './routers/feedback';
import { filesRouter } from './routers/files';
import { gitPrerequisiteRouter } from './routers/gitPrerequisite';
import { healthRouter } from './routers/health';
import { ideaComponentsRouter } from './routers/ideaComponents';
import { insightsRouter } from './routers/insights';
import { providerUsageRouter } from './routers/providerUsage';
import { questionsRouter } from './routers/questions';
import { tasksRouter } from './routers/tasks';
import { trackerRouter } from './routers/tracker';
import { reviewItemsRouter } from './routers/reviewItems';
import { sessionGitRouter } from './routers/sessionGit';
import { sessionsRouter } from './routers/sessions';
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
import { workspaceFilesRouter } from './routers/workspaceFiles';

export const appRouter = router({
  cyboflow: router({
    agentThread: agentThreadRouter,
    agents: agentsRouter,
    approvals: approvalsRouter,
    design: designRouter,
    artifacts: artifactsRouter,
    config: configRouter,
    customViews: customViewsRouter,
    customWidgetServer: customWidgetServerRouter,
    dynamicWorkflows: dynamicWorkflowsRouter,
    events: eventsRouter,
    experiments: experimentsRouter,
    feedback: feedbackRouter,
    files: filesRouter,
    gitPrerequisite: gitPrerequisiteRouter,
    health: healthRouter,
    ideaComponents: ideaComponentsRouter,
    insights: insightsRouter,
    mcps: mcpsRouter,
    monitor: monitorRouter,
    plugins: pluginsRouter,
    providerUsage: providerUsageRouter,
    questions: questionsRouter,
    reviewItems: reviewItemsRouter,
    runs: runsRouter,
    sessionGit: sessionGitRouter,
    sessions: sessionsRouter,
    substrates: substratesRouter,
    tasks: tasksRouter,
    tracker: trackerRouter,
    variants: variantsRouter,
    verificationRequests: verificationRequestsRouter,
    workflows: workflowsRouter,
    omp: ompRouter,
    ompCommand: ompCommandRouter,
    workspaceFiles: workspaceFilesRouter,
  }),
});

/** Inferred type of the full app router — re-exported from shared/types/trpc.ts
 *  so the frontend can import it without a direct main/ dependency. */
export type AppRouter = typeof appRouter;
