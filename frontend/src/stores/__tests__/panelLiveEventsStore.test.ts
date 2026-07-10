/**
 * panelLiveEventsStore tests.
 *
 * Coverage:
 *   1. appendEvent accumulates events for a panel, keyed independently per panel.
 *   2. A `result` envelope RESETS that panel's buffer (turn boundary) instead
 *      of appending-then-keeping it.
 *   3. The buffer is capped at MAX_EVENTS_PER_PANEL, dropping the oldest first
 *      (a ring-buffer trim), keeping the newest event.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { usePanelLiveEventsStore, MAX_EVENTS_PER_PANEL } from '../panelLiveEventsStore';
import type { StreamEvent } from '../../utils/cyboflowApi';

function streamEvent(index: number): StreamEvent {
  return {
    type: 'stream_event',
    payload: { event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(index) } } },
  } as unknown as StreamEvent;
}
function result(): StreamEvent {
  return { type: 'result', payload: { subtype: 'success' } } as unknown as StreamEvent;
}

beforeEach(() => {
  usePanelLiveEventsStore.getState().clearAll();
});

describe('panelLiveEventsStore', () => {
  it('appends events for a panel, independent of other panels', () => {
    const { appendEvent } = usePanelLiveEventsStore.getState();
    appendEvent('panel-a', streamEvent(1));
    appendEvent('panel-a', streamEvent(2));
    appendEvent('panel-b', streamEvent(9));

    const state = usePanelLiveEventsStore.getState();
    expect(state.byPanel['panel-a']).toHaveLength(2);
    expect(state.byPanel['panel-b']).toHaveLength(1);
  });

  it('a result envelope resets the panel buffer to empty', () => {
    const { appendEvent } = usePanelLiveEventsStore.getState();
    appendEvent('panel-a', streamEvent(1));
    appendEvent('panel-a', streamEvent(2));
    expect(usePanelLiveEventsStore.getState().byPanel['panel-a']).toHaveLength(2);

    appendEvent('panel-a', result());
    expect(usePanelLiveEventsStore.getState().byPanel['panel-a']).toEqual([]);

    // The next turn starts clean, not appended onto a stale result.
    appendEvent('panel-a', streamEvent(3));
    expect(usePanelLiveEventsStore.getState().byPanel['panel-a']).toHaveLength(1);
  });

  it('other panels are unaffected by one panel result-resetting', () => {
    const { appendEvent } = usePanelLiveEventsStore.getState();
    appendEvent('panel-a', streamEvent(1));
    appendEvent('panel-b', streamEvent(1));
    appendEvent('panel-a', result());

    const state = usePanelLiveEventsStore.getState();
    expect(state.byPanel['panel-a']).toEqual([]);
    expect(state.byPanel['panel-b']).toHaveLength(1);
  });

  it('caps the buffer at MAX_EVENTS_PER_PANEL, dropping the oldest first', () => {
    const { appendEvent } = usePanelLiveEventsStore.getState();
    for (let i = 0; i < MAX_EVENTS_PER_PANEL + 50; i++) {
      appendEvent('panel-a', streamEvent(i));
    }
    const buffered = usePanelLiveEventsStore.getState().byPanel['panel-a'];
    expect(buffered).toHaveLength(MAX_EVENTS_PER_PANEL);
    // The newest event survived; the oldest were trimmed.
    const last = buffered[buffered.length - 1] as unknown as {
      payload: { event: { delta: { text: string } } };
    };
    expect(last.payload.event.delta.text).toBe(String(MAX_EVENTS_PER_PANEL + 49));
  });
});
