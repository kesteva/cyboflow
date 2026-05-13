/**
 * Unit tests for LineBufferer.
 *
 * Tests the chunk-boundary preservation invariant, CRLF handling, empty input,
 * and flush behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LineBufferer } from '../lineBufferer';

describe('LineBufferer', () => {
  let lb: LineBufferer;

  beforeEach(() => {
    lb = new LineBufferer();
  });

  // -------------------------------------------------------------------------
  // Core documented invariant (from AC):
  //   feeding 'abc\ndef\ngh' followed by 'ij\n' yields ['abc', 'def', 'ghij']
  // -------------------------------------------------------------------------

  it('preserves partial trailing lines across chunk boundaries (core AC invariant)', () => {
    const lines1 = lb.feed('abc\ndef\ngh');
    expect(lines1).toEqual(['abc', 'def']);

    const lines2 = lb.feed('ij\n');
    expect(lines2).toEqual(['ghij']);
  });

  // -------------------------------------------------------------------------
  // Empty-tail case: when a chunk ends exactly at a newline boundary
  // -------------------------------------------------------------------------

  it('returns all lines and empty partial buffer when chunk ends with newline', () => {
    const lines = lb.feed('hello\nworld\n');
    expect(lines).toEqual(['hello', 'world']);
    // Buffer should be empty — flush returns nothing
    expect(lb.flush()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Single chunk with no newline
  // -------------------------------------------------------------------------

  it('returns empty array for a single chunk with no newline (partial held in buffer)', () => {
    const lines = lb.feed('partial-no-newline');
    expect(lines).toEqual([]);
    // Data is in the buffer — flush retrieves it
    expect(lb.flush()).toEqual(['partial-no-newline']);
  });

  // -------------------------------------------------------------------------
  // Empty input
  // -------------------------------------------------------------------------

  it('handles empty string chunk gracefully', () => {
    expect(lb.feed('')).toEqual([]);
    expect(lb.flush()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Multiple successive feeds
  // -------------------------------------------------------------------------

  it('accumulates partial lines across many 1-character feeds', () => {
    const data = 'foo\nbar\n';
    const allLines: string[] = [];
    for (const ch of data) {
      allLines.push(...lb.feed(ch));
    }
    expect(allLines).toEqual(['foo', 'bar']);
  });

  // -------------------------------------------------------------------------
  // CRLF handling
  // -------------------------------------------------------------------------

  it('strips trailing carriage returns from lines (CRLF safety)', () => {
    const lines = lb.feed('line1\r\nline2\r\n');
    expect(lines).toEqual(['line1', 'line2']);
  });

  it('strips trailing \\r from partial line returned by flush', () => {
    lb.feed('partial\r');
    // No newline — 'partial\r' is held in buffer
    expect(lb.flush()).toEqual(['partial']);
  });

  // -------------------------------------------------------------------------
  // Flush clears the buffer (idempotent after flush)
  // -------------------------------------------------------------------------

  it('flush is idempotent — second call returns empty', () => {
    lb.feed('some data');
    lb.flush();
    expect(lb.flush()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Multiple newlines in one chunk
  // -------------------------------------------------------------------------

  it('handles multiple newlines in a single chunk', () => {
    const lines = lb.feed('a\nb\nc\nd\n');
    expect(lines).toEqual(['a', 'b', 'c', 'd']);
  });

  // -------------------------------------------------------------------------
  // Chunk boundary splitting a JSON object (realistic scenario)
  // -------------------------------------------------------------------------

  it('correctly reassembles a JSON line split across two chunks', () => {
    const json = '{"type":"system","subtype":"init"}';
    const mid = Math.floor(json.length / 2);
    const chunk1 = json.slice(0, mid);
    const chunk2 = json.slice(mid) + '\n';

    const lines1 = lb.feed(chunk1);
    expect(lines1).toEqual([]); // No newline yet — buffered

    const lines2 = lb.feed(chunk2);
    expect(lines2).toEqual([json]);
  });
});
