/**
 * monitorReviewQueueComposition — the monitor's two REVIEW-QUEUE steering
 * actions (`resolve_review_item` / `file_note`), extracted verbatim from the
 * `monitorSteeringActions` holder built in index.ts's tRPC dep-wiring block
 * (GitHub issue #19, the god-file size ratchet). index.ts spreads the returned
 * pair into that holder next to the eight task/step-steering actions, so the
 * monitor's `MonitorSteeringActions` surface is unchanged.
 *
 * A SIBLING of index.ts on purpose (like verifyComposition.ts /
 * evalComposition.ts): composition-root code that reaches for the router and
 * HumanStepManager singletons, so it must stay OUT of main/src/orchestrator/**.
 * Pinned by main/src/__tests__/monitorReviewQueueComposition.test.ts (the
 * resolve path through the REAL ReviewItemRouter: outcome + `monitor` surface
 * provenance, the revise verdict, the attributable-reject warn); the handler's
 * own contract by resolveReviewItemHandler.test.ts / reviewItemRouter.test.ts,
 * and the parser/dispatch by monitor.test.ts.
 */
import { ReviewItemRouter } from './orchestrator/reviewItemRouter';
import { QuestionRouter } from './orchestrator/questionRouter';
import { TaskChangeRouter } from './orchestrator/taskChangeRouter';
import { HumanStepManager } from './orchestrator/humanStepManager';
import { resolveReviewItem as resolveReviewItemCore } from './orchestrator/resolveReviewItemHandler';
import { resumeWouldStrandEndedWalk } from './orchestrator/trpc/routers/reviewItems';
import type { MonitorActionResult } from './orchestrator/programmatic/monitor';
import type { DatabaseLike, LoggerLike } from './orchestrator/types';

/** The two review-queue members of index.ts's `MonitorSteeringActions`. */
export interface MonitorReviewQueueActions {
  resolveReviewItem(
    runId: string,
    input: { reviewItemId: string; outcome?: 'approve' | 'reject' | 'revise'; resolution?: string },
  ): Promise<MonitorActionResult>;
  fileNote(runId: string, input: { title: string; body?: string }): Promise<MonitorActionResult>;
}

export interface MonitorReviewQueueCompositionDeps {
  db: DatabaseLike;
  /** index.ts's run → project_id lookup, shared with the other steering actions. */
  runProjectId: (runId: string) => number | undefined;
  loggerLike: LoggerLike;
}

export function composeMonitorReviewQueueActions(deps: MonitorReviewQueueCompositionDeps): MonitorReviewQueueActions {
  const { db, runProjectId, loggerLike } = deps;
  return {
    resolveReviewItem: async (runId, input) => {
      const projectId = runProjectId(runId);
      if (projectId === undefined) return { ok: false, message: 'Run not found.' };
      const result = await resolveReviewItemCore(
        {
          projectId,
          reviewItemId: input.reviewItemId,
          ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
          ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
          // TASK-222 provenance: a stable id for this resolving surface, so a
          // gate answered from the monitor chat is attributable post-mortem.
          surface: 'monitor',
        },
        {
          db,
          applyReviewItemResolve: (pid, resolveArgs) =>
            ReviewItemRouter.getInstance().applyReviewItem(pid, {
              op: 'resolve',
              actor: resolveArgs.actor,
              reviewItemId: resolveArgs.reviewItemId,
              ...(resolveArgs.resolution != null ? { resolution: resolveArgs.resolution } : {}),
              // Forwarded exactly as reviewItems.ts's buildResolveDeps does —
              // dropping it here left monitor gate resolutions with no
              // resolvedOutcome/resolvedSurface in payload_json (TASK-222).
              ...(resolveArgs.resolutionMeta !== undefined ? { resolutionMeta: resolveArgs.resolutionMeta } : {}),
            }),
          promotePendingDraftsForRun: (rid) =>
            QuestionRouter.getInstance().promotePendingDraftsForRun(rid),
          deleteRunCreatedEntities: (pid, rid) =>
            TaskChangeRouter.getInstance().deleteRunCreatedEntities(pid, rid),
          maybeResumeRun: (rid) => HumanStepManager.getInstance().maybeResumeRun(rid),
          wouldStrandEndedWalk: resumeWouldStrandEndedWalk,
          logger: loggerLike,
        },
      );
      if (result.ok) {
        const verb =
          result.outcome === 'reject'
            ? 'Rejected'
            : result.outcome === 'approve'
              ? 'Approved'
              : result.outcome === 'revise'
                ? 'Sent back for revision on'
                : 'Resolved';
        return {
          ok: true,
          message: `${verb} the review item${result.resumed ? ' — the run is resuming.' : '.'}`,
        };
      }
      return { ok: false, message: result.message };
    },
    fileNote: async (runId, input) => {
      const projectId = runProjectId(runId);
      if (projectId === undefined) return { ok: false, message: 'Run not found.' };
      try {
        await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
          op: 'create',
          actor: 'orchestrator',
          kind: 'human_task',
          title: input.title,
          ...(input.body !== undefined ? { body: input.body } : {}),
          blocking: false,
          source: 'monitor',
          runId,
        });
        return { ok: true, message: `Filed a note in the review queue: '${input.title}'.` };
      } catch (err) {
        loggerLike.warn('[Main] monitor fileNote failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, message: 'Could not file the note.' };
      }
    },
  };
}
