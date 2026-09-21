/**
 * Composition-root wiring for the programmatic plane's human-gate resolver.
 *
 * This is `index.ts`'s `gate:` expression, extracted verbatim into a sibling so
 * the composition root stays one line and this seam's (substantial) rationale
 * has somewhere to live. It is pure wiring: every collaborator is a singleton
 * this module looks up at CALL time, so nothing here runs before
 * `HumanStepManager.initialize` / `GateSideEffects.initialize` have.
 */
import type { EventEmitter } from 'events';
import { GateSideEffects, gateDecisionFromResolution } from './gateSideEffects';
import { HumanStepManager } from './humanStepManager';
import { ReviewQueueHumanGate } from './programmatic/humanGate';
import type { LoggerLike } from './types';

export interface HumanGateWiringDeps {
  /** The review-item change emitter the resolver awaits resolutions on. */
  events: EventEmitter;
  /** Project id -> emitter channel name (reviewItemProjectChannel). */
  channelFor: (projectId: number) => string;
  logger?: LoggerLike;
}

/**
 * Build the production {@link ReviewQueueHumanGate}.
 *
 * The opener is HumanStepManager plus TWO extra hooks.
 *
 * `onGateResolved` is awaited inside ReviewQueueHumanGate.settleResumed BEFORE
 * the gate promise resolves — the single seam the controller genuinely waits on,
 * which is why the design bind lands here rather than after resolveReviewItem
 * returns. Anything hung off the resolve would race the resumed walk: the
 * review-item router's 'resolved' emit fires synchronously inside it and is what
 * wakes the gate, so by the time the resolve returns the next step is already
 * spawning and its `cyboflow_get_task` may see no approved_design at all.
 * GateSideEffects.apply is idempotent and never throws, so awaiting it here can
 * never hang a run at a gate the human already answered.
 *
 * `readGateItem` is the resolver's post-arming read-back: it closes the
 * lost-event window between finding/opening the gate item and arming the
 * listener's `targetId` filter, and supplies the gate's real title + body to the
 * `onOpened` hook (the body is composed inside the gate-open transaction, so it
 * does not exist any earlier).
 */
export function buildReviewQueueHumanGate(deps: HumanGateWiringDeps): ReviewQueueHumanGate {
  return new ReviewQueueHumanGate(
    {
      openHumanGate: (runId, stepId, stepName, gateHeader) =>
        HumanStepManager.getInstance().openHumanGate(runId, stepId, stepName, gateHeader),
      findPendingGate: (runId, stepId) => HumanStepManager.getInstance().findPendingGate(runId, stepId),
      maybeResumeRun: (runId) => HumanStepManager.getInstance().maybeResumeRun(runId),
      readGateItem: (reviewItemId) => HumanStepManager.getInstance().readGateItem(reviewItemId),
      onGateResolved: (args) =>
        GateSideEffects.getInstance().apply({
          runId: args.runId,
          stepId: args.stepId,
          // The opener reports the raw resolution note; the same sniff the
          // controller's own parseGateVerdict uses turns it into the verdict. A
          // DISMISSED gate is a rejection (the resolver itself maps it so) — its
          // null note must never sniff to 'approve' and bind a declined design.
          decision: args.dismissed ? 'reject' : gateDecisionFromResolution(args.resolution),
          resolution: args.resolution,
        }),
    },
    deps.events,
    deps.channelFor,
    deps.logger,
  );
}
