/**
 * Composition-root wiring for the programmatic plane's SYSTEMIC-PAUSE gate.
 *
 * This is `index.ts`'s `systemicGate:` expression, extracted into a sibling (the
 * `humanGateWiring.ts` precedent) so the composition root stays one call and this
 * seam's rationale has somewhere to live. It is pure wiring: every collaborator is
 * a singleton looked up at CALL time, so nothing here runs before
 * `HumanStepManager.initialize` / `ReviewItemRouter.initialize` have.
 *
 * WHY THE GATE EXISTS (the 2026-07-06 planner incident): a step failing with a
 * usage/session/rate-limit-class error PARKS the run behind a blocking 'decision'
 * item and auto-resumes at the parsed limit-reset time, instead of burning the
 * step's retry / optional-skip / triage budgets on a condition no retry can fix.
 * Item writes ride the ReviewItemRouter chokepoint (orchestrator actor);
 * park/resume rides the SAME HumanStepManager primitives as the blocking gate, so
 * a systemic pause participates in aggregate-unblock.
 */
import type { EventEmitter } from 'events';
import { HumanStepManager } from './humanStepManager';
import { ReviewQueueSystemicPauseGate } from './programmatic/systemicPauseGate';
import { ReviewItemRouter } from './reviewItemRouter';
import type { LoggerLike } from './types';

export interface SystemicPauseGateWiringDeps {
  /** The review-item change emitter the gate awaits resolutions on. */
  events: EventEmitter;
  /** Project id -> emitter channel name (reviewItemProjectChannel). */
  channelFor: (projectId: number) => string;
  logger?: LoggerLike;
}

/** Build the production {@link ReviewQueueSystemicPauseGate}. */
export function buildSystemicPauseGate(deps: SystemicPauseGateWiringDeps): ReviewQueueSystemicPauseGate {
  return new ReviewQueueSystemicPauseGate({
    items: {
      findPending: (runId, source) => HumanStepManager.getInstance().findPendingItemBySource(runId, source),
      create: async ({ runId, projectId, title, body, source }) => {
        const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
          op: 'create',
          actor: 'orchestrator',
          kind: 'decision',
          title,
          body,
          blocking: true,
          source,
          runId,
        });
        return reviewItemId;
      },
      resolve: async ({ projectId, reviewItemId, resolution }) => {
        await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
          op: 'resolve',
          actor: 'orchestrator',
          reviewItemId,
          resolution,
        });
      },
      dismiss: async ({ projectId, reviewItemId, resolution }) => {
        await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
          op: 'dismiss',
          actor: 'orchestrator',
          reviewItemId,
          resolution,
        });
      },
    },
    parker: HumanStepManager.getInstance(),
    events: deps.events,
    channelFor: deps.channelFor,
    logger: deps.logger,
  });
}
