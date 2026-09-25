/**
 * systemicPause — renderer-side readers for a `gate:systemic-pause:<stepId>`
 * review item (the BLOCKING decision item the programmatic plane opens when a
 * step's agent hits a subscription / session limit — see
 * `main/src/orchestrator/programmatic/systemicPauseGate.ts` and
 * docs/ARCHITECTURE.md → "Programmatic plane: systemic pauses and run-scoped
 * agent-target overrides").
 *
 * Shared by the three surfaces that read the same fact from the same row:
 *   - ReviewItemCard (the in-session pause card: Retry / Switch / Stop),
 *   - NeedsInputSection (the landing "Needs your input" row for the same item),
 *   - RunCenterPane → WorkflowCanvas / SprintSwimlaneCanvas (the parked step's
 *     card reads PAUSED instead of RUNNING — the run row itself stays
 *     'running' while parked, so the item is the only signal).
 *
 * Keyed on EITHER the source prefix (matches even a pause re-attached before
 * its payload landed, or across an app restart) OR the payload discriminant.
 * The payload is read through an `unknown` cast on purpose: a malformed one
 * must never throw out of a render.
 */
import type { ReviewItem } from '../../../shared/types/reviews';

export const SYSTEMIC_PAUSE_SOURCE_PREFIX = 'gate:systemic-pause:';

/** True for a systemic-pause decision item (by source prefix or payload gate). */
export function isSystemicPauseItem(item: ReviewItem): boolean {
  if (item.kind !== 'decision') return false;
  if ((item.source ?? '').startsWith(SYSTEMIC_PAUSE_SOURCE_PREFIX)) return true;
  const payload: unknown = item.payload;
  if (payload === null || typeof payload !== 'object') return false;
  const p = payload as { kind?: unknown; gate?: unknown };
  return p.kind === 'decision' && p.gate === 'systemic-pause';
}

/**
 * The pause payload's `origin` ('step' | 'triage'), or undefined when
 * absent / malformed / not a pause item. 'triage' means the run's Claude-only
 * supervisor (lane triage) hit the limit rather than a step agent — switching
 * step agents does not move it, so the switch action is withheld.
 */
export function systemicPauseOrigin(item: ReviewItem): 'step' | 'triage' | undefined {
  if (!isSystemicPauseItem(item)) return undefined;
  const payload: unknown = item.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const origin = (payload as { origin?: unknown }).origin;
  return origin === 'step' || origin === 'triage' ? origin : undefined;
}

/**
 * The step the pause is parked on: the source suffix first (always present on
 * a gate-minted row), else the payload's `stepId`. Null for a non-pause item
 * or one carrying neither.
 */
export function systemicPauseStepId(item: ReviewItem): string | null {
  if (!isSystemicPauseItem(item)) return null;
  const source = item.source ?? '';
  if (source.startsWith(SYSTEMIC_PAUSE_SOURCE_PREFIX)) {
    const suffix = source.slice(SYSTEMIC_PAUSE_SOURCE_PREFIX.length);
    if (suffix !== '') return suffix;
  }
  const payload: unknown = item.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const stepId = (payload as { stepId?: unknown }).stepId;
  return typeof stepId === 'string' && stepId !== '' ? stepId : null;
}

/**
 * The step `runId` is currently parked on by a PENDING systemic pause, or
 * null when it is not parked. At most one pause is pending per run (the gate
 * re-uses the run's pending item); the first match wins if that ever changes.
 */
export function pendingSystemicPauseStepId(items: readonly ReviewItem[], runId: string): string | null {
  for (const item of items) {
    if (item.run_id !== runId || item.status !== 'pending') continue;
    const stepId = systemicPauseStepId(item);
    if (stepId !== null) return stepId;
  }
  return null;
}
