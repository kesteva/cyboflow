/**
 * Integration tests for ClaudeStreamParser.
 *
 * Load-bearing test: the same fixture stream fed in 1-byte chunks,
 * 1024-byte chunks, and a single chunk must produce identical event arrays.
 *
 * Also covers: flush(), malformed-line recovery, per-runId routing via
 * EventRouter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeStreamParser } from '../streamParser';
import { EventRouter } from '../eventRouter';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Fixture loader — returns each fixture as a single-line JSON string (NDJSON)
// ---------------------------------------------------------------------------

function loadFixture(name: string): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(__dirname, '..', '__fixtures__', name), 'utf-8'),
  );
  // Compact (single-line) JSON — required for NDJSON line-per-event format.
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// Build a realistic multi-event fixture stream (NDJSON: one JSON object per line)
// ---------------------------------------------------------------------------

const FIXTURE_STREAM = [
  loadFixture('system_init.json'),
  loadFixture('assistant.json'),
  loadFixture('user_string_content.json'),
  loadFixture('assistant.json'),
  loadFixture('result_success.json'),
].join('\n') + '\n';

// ---------------------------------------------------------------------------
// Helper: collect all events emitted for a runId
// ---------------------------------------------------------------------------

function collectEvents(
  router: EventRouter,
  runId: string,
): ClaudeStreamEvent[] {
  const events: ClaudeStreamEvent[] = [];
  router.onRun(runId, (e) => events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// Helper: feed a string to a parser in fixed-size chunks
// ---------------------------------------------------------------------------

function feedInChunks(
  parser: ClaudeStreamParser,
  data: string,
  chunkSize: number,
): void {
  for (let i = 0; i < data.length; i += chunkSize) {
    parser.feed(data.slice(i, i + chunkSize));
  }
  parser.flush();
}

describe('ClaudeStreamParser', () => {
  let router: EventRouter;

  beforeEach(() => {
    router = new EventRouter();
  });

  // -------------------------------------------------------------------------
  // Load-bearing: chunk-boundary invariant
  //   Same fixture in 1-byte, 1024-byte, and single-chunk modes must produce
  //   identical event arrays.
  // -------------------------------------------------------------------------

  it('produces identical event sequences regardless of chunk size (1-byte / 1024-byte / single)', () => {
    const RUN = 'test-run';

    // --- 1-byte chunks ---
    const events1: ClaudeStreamEvent[] = [];
    const router1 = new EventRouter();
    const parser1 = new ClaudeStreamParser(RUN, router1);
    router1.onRun(RUN, (e) => events1.push(e));
    feedInChunks(parser1, FIXTURE_STREAM, 1);

    // --- 1024-byte chunks ---
    const events1024: ClaudeStreamEvent[] = [];
    const router1024 = new EventRouter();
    const parser1024 = new ClaudeStreamParser(RUN, router1024);
    router1024.onRun(RUN, (e) => events1024.push(e));
    feedInChunks(parser1024, FIXTURE_STREAM, 1024);

    // --- Single chunk ---
    const eventsFull: ClaudeStreamEvent[] = [];
    const routerFull = new EventRouter();
    const parserFull = new ClaudeStreamParser(RUN, routerFull);
    routerFull.onRun(RUN, (e) => eventsFull.push(e));
    feedInChunks(parserFull, FIXTURE_STREAM, FIXTURE_STREAM.length);

    // All three must be identical
    expect(events1).toHaveLength(5); // 5 fixture events
    expect(events1024).toHaveLength(5);
    expect(eventsFull).toHaveLength(5);

    expect(events1).toEqual(events1024);
    expect(events1).toEqual(eventsFull);
  });

  // -------------------------------------------------------------------------
  // Correct event types in the fixture stream
  // -------------------------------------------------------------------------

  it('emits events in the correct type order from the fixture stream', () => {
    const RUN = 'type-order-run';
    const events = collectEvents(router, RUN);
    const parser = new ClaudeStreamParser(RUN, router);
    feedInChunks(parser, FIXTURE_STREAM, FIXTURE_STREAM.length);

    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(events[1]).toMatchObject({ type: 'assistant' });
    expect(events[2]).toMatchObject({ type: 'user' });
    expect(events[3]).toMatchObject({ type: 'assistant' });
    expect(events[4]).toMatchObject({ type: 'result', subtype: 'success' });
  });

  // -------------------------------------------------------------------------
  // Malformed lines are dropped, pipeline continues
  // -------------------------------------------------------------------------

  it('recovers after a malformed JSON line and continues processing', () => {
    const logger = { warn: vi.fn(), verbose: vi.fn() };
    const RUN = 'recovery-run';
    const events = collectEvents(router, RUN);
    const parser = new ClaudeStreamParser(RUN, router, logger);

    // Mix of valid JSON, malformed input, and valid JSON
    const data = [
      loadFixture('system_init.json'),
      'not-valid-json',
      loadFixture('result_success.json'),
    ].join('\n') + '\n';

    feedInChunks(parser, data, data.length);

    // Two valid events emitted
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'system' });
    expect(events[1]).toMatchObject({ type: 'result', subtype: 'success' });

    // Warn was called for the malformed line
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toContain('not-valid-json');
  });

  // -------------------------------------------------------------------------
  // flush() emits a partial trailing line (no trailing newline)
  // -------------------------------------------------------------------------

  it('flush() emits a final event from a partial (non-newline-terminated) line', () => {
    const RUN = 'flush-run';
    const events = collectEvents(router, RUN);
    const parser = new ClaudeStreamParser(RUN, router);

    // Feed without trailing newline — the line stays in the buffer
    const json = loadFixture('system_init.json');
    parser.feed(json); // no newline at end
    expect(events).toHaveLength(0); // not emitted yet

    parser.flush(); // should emit the buffered line
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' });
  });

  // -------------------------------------------------------------------------
  // Per-runId isolation via EventRouter
  // -------------------------------------------------------------------------

  it('events from run-A are NOT received by run-B handler', () => {
    const eventsA: ClaudeStreamEvent[] = [];
    const eventsB: ClaudeStreamEvent[] = [];

    router.onRun('run-A', (e) => eventsA.push(e));
    router.onRun('run-B', (e) => eventsB.push(e));

    const parserA = new ClaudeStreamParser('run-A', router);
    const parserB = new ClaudeStreamParser('run-B', router);

    parserA.feed(loadFixture('system_init.json') + '\n');
    parserA.flush();
    parserB.feed(loadFixture('result_success.json') + '\n');
    parserB.flush();

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]).toMatchObject({ type: 'system' });

    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]).toMatchObject({ type: 'result' });
  });

  // -------------------------------------------------------------------------
  // Unknown event types fall through to catch-all (not dropped)
  // -------------------------------------------------------------------------

  it('unknown event type produces an __unknown__ catch-all event (not dropped)', () => {
    const RUN = 'unknown-run';
    const events = collectEvents(router, RUN);
    const parser = new ClaudeStreamParser(RUN, router);

    parser.feed('{"type":"brand_new_future_event","data":"hello"}\n');
    parser.flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: '__unknown__' });
    if (!('kind' in events[0])) throw new Error('Expected UnknownStreamEvent');
    expect(events[0].raw).toMatchObject({ type: 'brand_new_future_event' });
  });

  // -------------------------------------------------------------------------
  // Empty feed — no crash, no events
  // -------------------------------------------------------------------------

  it('handles empty string feed without throwing or emitting', () => {
    const RUN = 'empty-run';
    const events = collectEvents(router, RUN);
    const parser = new ClaudeStreamParser(RUN, router);

    expect(() => {
      parser.feed('');
      parser.flush();
    }).not.toThrow();
    expect(events).toHaveLength(0);
  });
});
