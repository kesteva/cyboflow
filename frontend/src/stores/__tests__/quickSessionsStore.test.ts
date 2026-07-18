/**
 * quickSessionsStore — change-detection tests.
 *
 * The 3s poll must not replace `rows` with a fresh-but-identical array: every
 * board subscriber re-renders on a `rows` identity change, so an unchanged
 * fetch should leave the existing reference in place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';

const { listQuick } = vi.hoisted(() => ({ listQuick: vi.fn() }));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      listQuick,
    },
  },
}));

import { useQuickSessionsStore } from '../quickSessionsStore';

function makeRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: 's1',
    name: 'session one',
    projectId: 1,
    runId: 'r1',
    state: 'idle',
    idleSince: null,
    unviewed: false,
    ...overrides,
  };
}

describe('quickSessionsStore.refresh', () => {
  beforeEach(() => {
    listQuick.mockReset();
    useQuickSessionsStore.setState({ rows: [] });
  });

  it('keeps the same rows reference across two consecutive fetches with identical payloads', async () => {
    listQuick.mockResolvedValueOnce({ success: true, data: [makeRow()] });
    await useQuickSessionsStore.getState().refresh();
    const first = useQuickSessionsStore.getState().rows;
    expect(first).toEqual([makeRow()]);

    // A fresh array/object instance from the second fetch, but identical content.
    listQuick.mockResolvedValueOnce({ success: true, data: [makeRow()] });
    await useQuickSessionsStore.getState().refresh();
    const second = useQuickSessionsStore.getState().rows;

    expect(second).toBe(first);
  });

  it('replaces rows with a new reference when the payload actually changes', async () => {
    listQuick.mockResolvedValueOnce({ success: true, data: [makeRow()] });
    await useQuickSessionsStore.getState().refresh();
    const first = useQuickSessionsStore.getState().rows;

    listQuick.mockResolvedValueOnce({ success: true, data: [makeRow({ state: 'running' })] });
    await useQuickSessionsStore.getState().refresh();
    const second = useQuickSessionsStore.getState().rows;

    expect(second).not.toBe(first);
    expect(second[0].state).toBe('running');
  });

  it('replaces rows when the row count changes', async () => {
    listQuick.mockResolvedValueOnce({ success: true, data: [makeRow()] });
    await useQuickSessionsStore.getState().refresh();
    const first = useQuickSessionsStore.getState().rows;

    listQuick.mockResolvedValueOnce({ success: true, data: [makeRow(), makeRow({ sessionId: 's2' })] });
    await useQuickSessionsStore.getState().refresh();
    const second = useQuickSessionsStore.getState().rows;

    expect(second).not.toBe(first);
    expect(second).toHaveLength(2);
  });
});
