import { describe, it, expect } from 'vitest';
import { sortQuickSessionRows } from '../landing/QuickSessionsTable';
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
