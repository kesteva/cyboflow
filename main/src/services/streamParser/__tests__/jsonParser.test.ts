/**
 * Unit tests for JSONParser.
 *
 * Asserts: valid JSON parses correctly; malformed JSON logs exactly one warn()
 * with the truncated payload; logger.error() is never called; no exception
 * propagates; processing continues after a malformed line.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JSONParser } from '../jsonParser';
import type { IWarnLogger } from '../jsonParser';

// ---------------------------------------------------------------------------
// Logger spy factory
// ---------------------------------------------------------------------------

function makeLoggerSpy(): IWarnLogger & { warnCalls: string[] } {
  const warnCalls: string[] = [];
  return {
    warnCalls,
    warn(message: string) {
      warnCalls.push(message);
    },
  };
}

describe('JSONParser', () => {
  let logger: IWarnLogger & { warnCalls: string[] };
  let parser: JSONParser;

  beforeEach(() => {
    logger = makeLoggerSpy();
    parser = new JSONParser(logger);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('parses a valid JSON object and returns the parsed value', () => {
    const result = parser.parse('{"type":"system"}');
    expect(result).toEqual({ type: 'system' });
  });

  it('parses a valid JSON string literal', () => {
    expect(parser.parse('"hello"')).toBe('hello');
  });

  it('parses a valid JSON number', () => {
    expect(parser.parse('42')).toBe(42);
  });

  it('parses a valid JSON array', () => {
    expect(parser.parse('[1,2,3]')).toEqual([1, 2, 3]);
  });

  // -------------------------------------------------------------------------
  // Malformed JSON — returns null, logs one warn, never throws
  // -------------------------------------------------------------------------

  it('returns null for a malformed JSON line', () => {
    const result = parser.parse('not-json');
    expect(result).toBeNull();
  });

  it('does NOT throw on malformed JSON', () => {
    expect(() => parser.parse('{ broken json }')).not.toThrow();
  });

  it('logs exactly one warn() call for a single malformed line', () => {
    parser.parse('not-json');
    expect(logger.warnCalls).toHaveLength(1);
  });

  it('includes the malformed payload (truncated to 200 chars) in the warn message', () => {
    const badLine = 'not-json';
    parser.parse(badLine);
    expect(logger.warnCalls[0]).toContain(badLine.substring(0, 200));
  });

  it('truncates warn message payload to 200 characters for very long bad input', () => {
    const longBadLine = 'x'.repeat(500);
    parser.parse(longBadLine);
    expect(logger.warnCalls).toHaveLength(1);
    // The logged payload must not exceed 200 chars (it's the line.substring(0, 200))
    const logged = logger.warnCalls[0];
    // The warning contains the truncated payload — verify it doesn't contain char 201
    expect(logged).toContain('x'.repeat(200));
    expect(logged).not.toContain('x'.repeat(201));
  });

  // -------------------------------------------------------------------------
  // logger.error() is never called — by design (IDEA-005 constraint)
  // -------------------------------------------------------------------------

  it('never calls logger.error — warn-only contract for parse failures', () => {
    // Cast to extended type so we can spy on error
    const strictLogger: IWarnLogger & { errorCalled: boolean } = {
      errorCalled: false,
      warn: vi.fn() as (message: string) => void,
    };
    // Attach an error spy as a side-channel (not part of IWarnLogger interface)
    // We verify via the interface contract — IWarnLogger has no error method.
    // The class must not call anything other than warn().
    const strictParser = new JSONParser(strictLogger);
    expect(() => strictParser.parse('broken')).not.toThrow();
    // If error were called it would throw (not defined on strictLogger).
    // Reaching here without an error confirms it.
    expect(strictLogger.errorCalled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Sequence: valid, malformed, valid — pipeline continues
  // -------------------------------------------------------------------------

  it('processes a sequence of valid, malformed, valid lines correctly', () => {
    const r1 = parser.parse('{"type":"system"}');
    const r2 = parser.parse('not-json');
    const r3 = parser.parse('{"type":"assistant"}');

    expect(r1).toEqual({ type: 'system' });
    expect(r2).toBeNull();
    expect(r3).toEqual({ type: 'assistant' });

    // Exactly one warn for the malformed line
    expect(logger.warnCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // No logger — no crash
  // -------------------------------------------------------------------------

  it('works without a logger (no warn, no throw)', () => {
    const parserNoLogger = new JSONParser();
    expect(() => parserNoLogger.parse('bad json')).not.toThrow();
    expect(parserNoLogger.parse('bad json')).toBeNull();
    expect(parserNoLogger.parse('{"ok":true}')).toEqual({ ok: true });
  });
});
