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
 *
 * It also exports the two adapters the "Switch runtime & retry" handler
 * (switchRunAgentsHandler.ts) needs to act on the SAME pause item the gate owns:
 * {@link findPendingSystemicPause} (id + project + parsed payload) and
 * {@link resolveSystemicPauseItem} (a human-actor resolve that reports a lost race
 * against the auto-resume timer as `'already_settled'` instead of throwing).
 */
import type { EventEmitter } from 'events';
import type { DecisionPayload } from '../../../shared/types/reviews';
import { HumanStepManager } from './humanStepManager';
import { ReviewQueueSystemicPauseGate } from './programmatic/systemicPauseGate';
import { ReviewItemError, ReviewItemRouter } from './reviewItemRouter';
import type { LoggerLike } from './types';

export interface SystemicPauseGateWiringDeps {
  /** The review-item change emitter the gate awaits resolutions on. */
  events: EventEmitter;
  /** Project id -> emitter channel name (reviewItemProjectChannel). */
  channelFor: (projectId: number) => string;
  logger?: LoggerLike;
}

/**
 * Build the production {@link ReviewQueueSystemicPauseGate}. The `create`
 * adapter forwards the gate-composed `DecisionPayload` (gate 'systemic-pause':
 * the blocked step, agent keys, provider, origin) so the pause card can offer a
 * "Switch runtime & retry" scoped to exactly what was blocked.
 */
export function buildSystemicPauseGate(deps: SystemicPauseGateWiringDeps): ReviewQueueSystemicPauseGate {
  return new ReviewQueueSystemicPauseGate({
    items: {
      findPending: (runId, source) => HumanStepManager.getInstance().findPendingItemBySource(runId, source),
      create: async ({ runId, projectId, title, body, source, payload }) => {
        const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
          op: 'create',
          actor: 'orchestrator',
          kind: 'decision',
          title,
          body,
          blocking: true,
          source,
          runId,
          ...(payload ? { payload } : {}),
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

/** The run's pending systemic-pause item, with its parsed decision payload. */
export interface PendingSystemicPause {
  reviewItemId: string;
  projectId: number;
  /** The gate-minted payload; null for a pre-feature item (payload_json NULL) or unparseable JSON. */
  payload: DecisionPayload | null;
}

/**
 * Narrow a parsed payload_json to a decision payload. Anything else (a
 * pre-feature NULL, a malformed blob, a non-decision discriminant) is null — the
 * switch handler then falls back to the run's provider.
 */
function parseDecisionPayload(json: string | null): DecisionPayload | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.kind !== 'decision' || typeof rec.gate !== 'string') return null;
    return parsed as DecisionPayload;
  } catch {
    return null;
  }
}

/**
 * The run's pending systemic-pause item (any step) + its parsed payload, or null.
 * Read-only; fail-soft (a missing inbox table yields null).
 */
export async function findPendingSystemicPause(runId: string): Promise<PendingSystemicPause | null> {
  const hit = await HumanStepManager.getInstance().findPendingSystemicPauseItem(runId);
  if (!hit) return null;
  return { reviewItemId: hit.reviewItemId, projectId: hit.projectId, payload: parseDecisionPayload(hit.payloadJson) };
}

/**
 * Resolve the pause item as the HUMAN actor (the operator's "Switch runtime &
 * retry"), which the gate settles as 'retry'. A router `invalid_status` means the
 * item is no longer pending — the auto-resume timer (or a concurrent human action)
 * won the race — and is reported as `'already_settled'`, never thrown: the caller
 * has already written its override and must not surface an error after a write.
 * Anything else rethrows.
 */
export async function resolveSystemicPauseItem(args: {
  projectId: number;
  reviewItemId: string;
  resolution: string;
}): Promise<'resolved' | 'already_settled'> {
  try {
    await ReviewItemRouter.getInstance().applyReviewItem(args.projectId, {
      op: 'resolve',
      actor: 'user',
      reviewItemId: args.reviewItemId,
      resolution: args.resolution,
    });
    return 'resolved';
  } catch (err) {
    if (err instanceof ReviewItemError && err.code === 'invalid_status') return 'already_settled';
    throw err;
  }
}
