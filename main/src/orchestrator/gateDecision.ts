/**
 * Gate verdict sniff — the ONE reading of a human gate's stored resolution shared
 * by every non-controller call site. A leaf module on purpose (shared types only):
 * `gateSideEffects` re-exports it, `adversarialReviewGateBody` imports it directly.
 */
import { parseGateResolution } from '../../../shared/types/reviews';

/** The human's answer, as the gate resolver reports it. */
export type GateDecision = 'approve' | 'revise' | 'reject' | 'abort';

/**
 * The verdict a resolution note encodes.
 *
 * Mirrors `programmatic/humanGate.parseGateVerdict` exactly, and lives in this
 * LEAF module so every call site that has a resolution string but not a decision
 * (the gate opener's `onGateResolved`, the orchestrated-plane resolve, the
 * approve-design gate body's revision count) reads it the SAME way the
 * controller does — without a `programmatic/` import and without a module cycle
 * through `gateSideEffects`. Duplicated rather than imported from `programmatic/`
 * for the same reason humanStepManager.ts keeps its copied constants.
 *
 * Both serialized verdict-map prefixes spell a declined item 'deny', never
 * 'reject', precisely so a batch gate carrying denials still reads as
 * approve-to-proceed here.
 *
 * A null/empty note is an APPROVE, deliberately and in agreement with
 * `parseGateVerdict`: resolving a blocking gate IS the act of approval, and the
 * queue card's Approve button records no note. Do NOT "harden" this by reading
 * null as a rejection — a DISMISSED gate also arrives with a null note, but the
 * two are told apart by the opener's own `dismissed` flag (see the
 * `onGateResolved` wiring in main/src/index.ts), not by the string. Suppressing
 * on null would silently stop binding designs on the most common approve path.
 */
export function gateDecisionFromResolution(resolution: string | null | undefined): GateDecision {
  // PREFIX FIRST (same contract as parseGateVerdict): a resolution written by
  // `composeGateResolution` carries an anchored verdict, so the note after the
  // colon is never sniffed — 'revise: the architecture rejects empty input' is a
  // REVISE. Only a legacy row (parse returns null) falls through to the sniff.
  const parsed = parseGateResolution(resolution);
  if (parsed !== null) return parsed.verdict;
  const r = (resolution ?? '').trim().toLowerCase();
  if (r.includes('reject')) return 'reject';
  if (r.includes('revise') || r.includes('retry')) return 'revise';
  return 'approve';
}
