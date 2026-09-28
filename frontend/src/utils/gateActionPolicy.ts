/**
 * gateActionPolicy — the one place a surface decides which VERDICT a
 * "not approve" click on a decision gate records.
 *
 * TASK-222 introduced `gateDeclineOutcome` inside `ReviewItemCard.tsx` to stop a
 * future surface/collapse from hardcoding a bare 'reject' for the approve-design
 * gate's loopback (the 2026-09-17 swift-bison incident: `defaultEscalationActions`'s
 * discard button used to send 'reject' for every decision kind, silently ending a
 * run that should have looped back to `expand-spec`/`ui-prototype` instead). That
 * mapping stayed PRIVATE to the card, so `ArtifactTabRenderer`'s own gate controls
 * (the decomposed-stories approve-plan control, the approve-designs verdict grid)
 * never got a chance to consume it and remain free to reintroduce the same class of
 * bug the moment either surface grows a decline path for a gate that declares a
 * loopback. Import from here instead of re-deriving the discriminant locally.
 */

import type { ReviewItem } from '../../../shared/types/reviews';

/**
 * True for a decision item minted by EITHER the programmatic runner's singular
 * `gate:human-step:approve-design` source OR the default ORCHESTRATED planner's
 * payload-discriminated `gate: 'approve-design'` (source `agent:<label>`, the gate
 * is only discoverable via the payload there). Deliberately distinct from the
 * programmatic-only, plural `approve-designs` BATCH gate (`ArtifactTabRenderer`'s
 * `ApproveDesignsBody`), which resolves with a per-idea verdict map, not a single
 * outcome, and so has no decline-outcome question to answer.
 */
export function isApproveDesignGateItem(item: ReviewItem): boolean {
  if (item.kind !== 'decision') return false;
  if (item.source === 'gate:human-step:approve-design') return true;
  const payload = item.payload;
  return Boolean(payload && payload.kind === 'decision' && payload.gate === 'approve-design');
}

/**
 * Which verdict a "not approve" click on `item` should record. A gate that
 * declares an intra-phase `loopback` (today, the ONLY one among human gates:
 * `approve-design` — shared/types/workflows.ts) must never have its decline
 * recorded as a plain terminal 'reject': that ENDS the run instead of looping
 * back with the human's note + the adversarial review threaded in.
 *
 * ONE function, consumed by every surface that offers a decline action for a
 * decision item — extend the underlying discriminant (currently just
 * {@link isApproveDesignGateItem}) when a future gate adds a loopback, never add
 * a new per-surface conditional.
 */
export function gateDeclineOutcome(item: ReviewItem): 'reject' | 'revise' {
  return isApproveDesignGateItem(item) ? 'revise' : 'reject';
}
