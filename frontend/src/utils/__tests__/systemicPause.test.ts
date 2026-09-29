/**
 * systemicPause — the shared readers for a `gate:systemic-pause:<stepId>`
 * item: recognition by source prefix OR payload gate, origin, the parked step
 * id (source suffix first, payload fallback), and the per-run pending lookup.
 */
import { describe, it, expect } from 'vitest';
import type { ReviewItem, ReviewItemPayload } from '../../../../shared/types/reviews';
import {
  isSystemicPauseItem,
  pendingSystemicPauseStepId,
  systemicPauseOrigin,
  systemicPauseStepId,
} from '../systemicPause';

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'rvw_1',
    project_id: 1,
    run_id: 'run-1',
    entity_type: null,
    entity_id: null,
    kind: 'decision',
    status: 'pending',
    blocking: true,
    audience: 'human',
    title: 'Paused: usage limit',
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: 'gate:systemic-pause:interview',
    payload: null,
    created_at: '2026-09-23T00:00:00.000Z',
    updated_at: '2026-09-23T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

const pausePayload = (extra: Record<string, unknown> = {}): ReviewItemPayload =>
  ({ kind: 'decision', gate: 'systemic-pause', stepId: 'implement', ...extra }) as unknown as ReviewItemPayload;

describe('systemicPause', () => {
  it('recognizes a pause by its source prefix, by its payload gate, and neither for other decisions', () => {
    expect(isSystemicPauseItem(item())).toBe(true);
    expect(isSystemicPauseItem(item({ source: 'gate:human-step:x', payload: pausePayload() }))).toBe(true);
    expect(isSystemicPauseItem(item({ source: 'gate:human-step:x' }))).toBe(false);
    expect(isSystemicPauseItem(item({ kind: 'finding' }))).toBe(false);
  });

  it('reads the origin only when well-formed', () => {
    expect(systemicPauseOrigin(item())).toBeUndefined();
    expect(systemicPauseOrigin(item({ payload: pausePayload({ origin: 'triage' }) }))).toBe('triage');
    expect(systemicPauseOrigin(item({ payload: pausePayload({ origin: 'bogus' }) }))).toBeUndefined();
    expect(systemicPauseOrigin(item({ source: 'gate:human-step:x' }))).toBeUndefined();
  });

  it('takes the step id from the source suffix first, the payload second, and null otherwise', () => {
    expect(systemicPauseStepId(item())).toBe('interview');
    expect(systemicPauseStepId(item({ source: 'gate:human-step:x', payload: pausePayload() }))).toBe('implement');
    expect(systemicPauseStepId(item({ source: 'gate:systemic-pause:', payload: pausePayload() }))).toBe('implement');
    expect(systemicPauseStepId(item({ source: 'gate:human-step:x', payload: pausePayload({ stepId: '' }) }))).toBeNull();
    expect(systemicPauseStepId(item({ source: 'gate:human-step:x' }))).toBeNull();
  });

  it('pendingSystemicPauseStepId matches only THIS run\'s PENDING pause', () => {
    const items = [
      item({ id: 'a', run_id: 'run-2' }),
      item({ id: 'b', status: 'resolved' }),
      item({ id: 'c', source: 'gate:human-step:approve-brief' }),
      item({ id: 'd', source: 'gate:systemic-pause:ideas' }),
    ];
    expect(pendingSystemicPauseStepId(items, 'run-1')).toBe('ideas');
    expect(pendingSystemicPauseStepId(items, 'run-2')).toBe('interview');
    expect(pendingSystemicPauseStepId(items, 'run-3')).toBeNull();
    expect(pendingSystemicPauseStepId([], 'run-1')).toBeNull();
  });
});
