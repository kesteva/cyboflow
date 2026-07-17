import { describe, it, expect } from 'vitest';
import {
  sortQuickSessionRows,
  overrideRunningForActiveWorkflows,
} from '../landing/QuickSessionsTable';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';

function row(o: Partial<QuickSessionRow>): QuickSessionRow {
  return {
    sessionId: o.sessionId ?? 'id',
    name: o.name ?? 'name',
    projectId: 1,
    runId: 'r',
    state: o.state ?? 'idle',
    idleSince: o.idleSince ?? null,
    unviewed: o.unviewed ?? false,
  };
}

describe('sortQuickSessionRows', () => {
  it('orders blocked → idle-unviewed → idle-viewed → running', () => {
    const rows = [
      row({ sessionId: 'running', state: 'running' }),
      row({ sessionId: 'idle-viewed', state: 'idle', unviewed: false, idleSince: '2026-07-06T10:00:00Z' }),
      row({ sessionId: 'blocked', state: 'blocked' }),
      row({ sessionId: 'idle-unviewed', state: 'idle', unviewed: true, idleSince: '2026-07-06T10:00:00Z' }),
    ];
    expect(sortQuickSessionRows(rows).map((r) => r.sessionId)).toEqual([
      'blocked',
      'idle-unviewed',
      'idle-viewed',
      'running',
    ]);
  });

  it('within idle, longest-quiet (oldest idleSince) first', () => {
    const rows = [
      row({ sessionId: 'newer', state: 'idle', unviewed: true, idleSince: '2026-07-06T10:00:00Z' }),
      row({ sessionId: 'older', state: 'idle', unviewed: true, idleSince: '2026-07-06T08:00:00Z' }),
    ];
    expect(sortQuickSessionRows(rows).map((r) => r.sessionId)).toEqual(['older', 'newer']);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ sessionId: 'a', state: 'running' }), row({ sessionId: 'b', state: 'blocked' })];
    const before = rows.map((r) => r.sessionId);
    sortQuickSessionRows(rows);
    expect(rows.map((r) => r.sessionId)).toEqual(before);
  });
});

describe('overrideRunningForActiveWorkflows', () => {
  it('flips an idle row with a live dynamic workflow to running (clears idleSince)', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince: '2026-07-06T10:00:00Z', unviewed: true })];
    const out = overrideRunningForActiveWorkflows(rows, new Set(['s1']));
    expect(out[0].state).toBe('running');
    expect(out[0].idleSince).toBeNull();
  });

  it('leaves an idle row WITHOUT a live workflow untouched', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince: '2026-07-06T10:00:00Z' })];
    const out = overrideRunningForActiveWorkflows(rows, new Set(['other']));
    expect(out[0].state).toBe('idle');
    expect(out[0].idleSince).toBe('2026-07-06T10:00:00Z');
  });

  it('never overrides a blocked row even with a live workflow (question still wins)', () => {
    const rows = [row({ sessionId: 's1', state: 'blocked', idleSince: null })];
    const out = overrideRunningForActiveWorkflows(rows, new Set(['s1']));
    expect(out[0].state).toBe('blocked');
  });

  it('does not mutate the input rows', () => {
    const rows = [row({ sessionId: 's1', state: 'idle', idleSince: '2026-07-06T10:00:00Z' })];
    overrideRunningForActiveWorkflows(rows, new Set(['s1']));
    expect(rows[0].state).toBe('idle');
    expect(rows[0].idleSince).toBe('2026-07-06T10:00:00Z');
  });
});
