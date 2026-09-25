/**
 * Slot helpers shared by the rubric jury (evalWorker.ts / codexJudge.ts) and the
 * pairwise panel (pairwiseJudgeWorker.ts / codexPairwiseJudge.ts). The pairwise
 * tree was built as a mirror of the rubric tree; these were byte-identical clones
 * across the two, and the error cap had silently drifted (200 vs 500), so they
 * live here once.
 */

/**
 * Cap on the per-slot failure message persisted into jury_json. A generic thrown
 * juror error (turn.failed message, malformed JSON, app-server exit, strict-schema
 * 400) is otherwise written ONLY to the per-launch-truncated backend log, leaving
 * a dropped slot undiagnosable after the fact — so the reason is stored on the
 * slot provenance, truncated to keep the row bounded.
 */
export const MAX_SLOT_ERROR_CHARS = 500;

/** Truncate a juror failure message for durable slot provenance. */
export function truncateSlotError(message: string): string {
  return message.length <= MAX_SLOT_ERROR_CHARS
    ? message
    : `${message.slice(0, MAX_SLOT_ERROR_CHARS)}…`;
}

/** Prefer the judge's live resolved model; fall back to the slot's declared one. */
export function resolveSlotModel(slot: { model: string | null; judge: object }): string | null {
  if ('resolvedModel' in slot.judge) {
    const resolvedModel = (slot.judge as { resolvedModel?: unknown }).resolvedModel;
    if (typeof resolvedModel === 'string' && resolvedModel.length > 0) return resolvedModel;
  }
  return slot.model;
}

export interface QueryWithResolvedModel {
  getResolvedModel(): string | null;
}

/** True when a structured-query fn can report the model it actually resolved. */
export function hasResolvedModel<Q extends object>(query: Q): query is Q & QueryWithResolvedModel {
  return 'getResolvedModel' in query
    && typeof (query as { getResolvedModel?: unknown }).getResolvedModel === 'function';
}
