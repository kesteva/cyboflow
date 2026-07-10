/**
 * liveTailReducer tests.
 *
 * Fixture style mirrors runContextUsage.test.ts: the real StreamEvent union
 * carries fields the reducer never reads (timestamp, session_id, uuid, …), so
 * fixtures fake the minimal shape and cast.
 */
import { describe, it, expect } from 'vitest';
import { reduceLiveTail } from '../liveTailReducer';
import type { StreamEvent } from '../cyboflowApi';

function streamEvent(event: Record<string, unknown>): StreamEvent {
  return { type: 'stream_event', payload: { event } } as unknown as StreamEvent;
}
function result(): StreamEvent {
  return { type: 'result', payload: { subtype: 'success' } } as unknown as StreamEvent;
}

function blockStart(index: number, blockType: string): StreamEvent {
  return streamEvent({ type: 'content_block_start', index, content_block: { type: blockType } });
}
function textDelta(index: number, text: string): StreamEvent {
  return streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
}
function thinkingDelta(index: number, thinking: string): StreamEvent {
  return streamEvent({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
}
function inputJsonDelta(index: number, partial_json: string): StreamEvent {
  return streamEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
}
function blockStop(index: number): StreamEvent {
  return streamEvent({ type: 'content_block_stop', index });
}
function messageStart(): StreamEvent {
  return streamEvent({ type: 'message_start' });
}
function messageStop(): StreamEvent {
  return streamEvent({ type: 'message_stop' });
}

describe('reduceLiveTail', () => {
  it('returns empty state for no events', () => {
    expect(reduceLiveTail([])).toEqual({ activeBlocks: [], isGenerating: false });
  });

  it('accumulates a single text block across deltas', () => {
    const state = reduceLiveTail([
      messageStart(),
      blockStart(0, 'text'),
      textDelta(0, 'Hello'),
      textDelta(0, ', world'),
    ]);
    expect(state.isGenerating).toBe(true);
    expect(state.activeBlocks).toEqual([{ index: 0, kind: 'text', text: 'Hello, world' }]);
  });

  it('interleaves multiple text+thinking blocks by index, ordered ascending', () => {
    const state = reduceLiveTail([
      messageStart(),
      blockStart(0, 'thinking'),
      blockStart(1, 'text'),
      thinkingDelta(0, 'pondering'),
      textDelta(1, 'answer'),
      thinkingDelta(0, ' more'),
      textDelta(1, ' text'),
    ]);
    expect(state.activeBlocks).toEqual([
      { index: 0, kind: 'thinking', text: 'pondering more' },
      { index: 1, kind: 'text', text: 'answer text' },
    ]);
  });

  it('excludes tool_use blocks entirely — input_json_delta produces no block', () => {
    const state = reduceLiveTail([
      messageStart(),
      blockStart(0, 'tool_use'),
      inputJsonDelta(0, '{"foo":'),
      inputJsonDelta(0, '"bar"}'),
    ]);
    expect(state.activeBlocks).toEqual([]);
    // Still generating — the spinner/working-indicator path covers this case.
    expect(state.isGenerating).toBe(true);
  });

  it('content_block_stop removes the block from the tail', () => {
    const state = reduceLiveTail([
      messageStart(),
      blockStart(0, 'text'),
      textDelta(0, 'partial'),
      blockStop(0),
    ]);
    expect(state.activeBlocks).toEqual([]);
    expect(state.isGenerating).toBe(true);
  });

  it('a stopped block does not reappear after a sibling keeps streaming', () => {
    const state = reduceLiveTail([
      messageStart(),
      blockStart(0, 'text'),
      textDelta(0, 'done text'),
      blockStop(0),
      blockStart(1, 'text'),
      textDelta(1, 'still going'),
    ]);
    expect(state.activeBlocks).toEqual([{ index: 1, kind: 'text', text: 'still going' }]);
  });

  it('clears on a result envelope — nothing after the turn boundary is scanned', () => {
    const events = [
      messageStart(),
      blockStart(0, 'text'),
      textDelta(0, 'first turn'),
      blockStop(0),
      messageStop(),
      result(),
    ];
    expect(reduceLiveTail(events)).toEqual({ activeBlocks: [], isGenerating: false });
  });

  it('only scans events AFTER the last result — a new turn starts fresh', () => {
    const events = [
      messageStart(),
      blockStart(0, 'text'),
      textDelta(0, 'first turn leftover'), // never stopped, but pre-dates the result
      result(),
      messageStart(),
      blockStart(0, 'text'),
      textDelta(0, 'second turn'),
    ];
    expect(reduceLiveTail(events).activeBlocks).toEqual([{ index: 0, kind: 'text', text: 'second turn' }]);
  });

  it('replaying the SAME array twice is idempotent (pure function, no hidden state)', () => {
    const events = [messageStart(), blockStart(0, 'text'), textDelta(0, 'abc')];
    const first = reduceLiveTail(events);
    const second = reduceLiveTail(events);
    expect(second).toEqual(first);
  });

  it('ignores malformed events without throwing: missing event, non-numeric index, unknown delta type', () => {
    const malformed: StreamEvent[] = [
      { type: 'stream_event', payload: {} } as unknown as StreamEvent, // no `event` at all
      streamEvent({ type: 'content_block_delta', index: 'not-a-number', delta: { type: 'text_delta', text: 'x' } }),
      streamEvent({ type: 'content_block_start' }), // no index
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
      { type: 'assistant', payload: {} } as unknown as StreamEvent, // wrong envelope type entirely
    ];
    expect(() => reduceLiveTail(malformed)).not.toThrow();
    expect(reduceLiveTail(malformed).activeBlocks).toEqual([]);
  });

  it('isGenerating is false when the log has no stream_event since the last result', () => {
    const events = [result()];
    expect(reduceLiveTail(events)).toEqual({ activeBlocks: [], isGenerating: false });
  });
});
