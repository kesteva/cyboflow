/**
 * Unit tests for TypedEventNarrowing.
 *
 * Covers: known event types narrow to their tagged variant; unknown
 * discriminants fall through to { kind: '__unknown__', raw }; no throws;
 * passthrough fields survive; the system/init and assistant/tool_use fixtures
 * are used as real-world inputs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TypedEventNarrowing } from '../typedEventNarrowing';

// ---------------------------------------------------------------------------
// Fixture loader helper
// ---------------------------------------------------------------------------

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, '..', '__fixtures__', name), 'utf-8'),
  );
}

describe('TypedEventNarrowing', () => {
  let narrower: TypedEventNarrowing;

  beforeEach(() => {
    narrower = new TypedEventNarrowing();
  });

  // -------------------------------------------------------------------------
  // system/init fixture — narrows to SystemInitEvent
  // -------------------------------------------------------------------------

  it('narrows system_init.json to system/init variant', () => {
    const raw = loadFixture('system_init.json');
    const event = narrower.narrow(raw);

    expect('kind' in event).toBe(false);
    if ('kind' in event) throw new Error('Expected typed variant');
    expect(event.type).toBe('system');
    if (event.type !== 'system' || event.subtype !== 'init') {
      throw new Error('Expected SystemInitEvent');
    }
    expect(event.subtype).toBe('init');
    expect(typeof event.session_id).toBe('string');
  });

  // -------------------------------------------------------------------------
  // assistant/tool_use fixture — narrows to AssistantEvent
  // -------------------------------------------------------------------------

  it('narrows assistant.json (with tool_use block) to assistant variant', () => {
    const raw = loadFixture('assistant.json');
    const event = narrower.narrow(raw);

    expect('kind' in event).toBe(false);
    if ('kind' in event) throw new Error('Expected typed variant');
    expect(event.type).toBe('assistant');
    if (event.type !== 'assistant') throw new Error('Expected AssistantEvent');

    const hasToolUse = event.message.content.some(
      (block) => block.type === 'tool_use',
    );
    expect(hasToolUse).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Unknown discriminant — returns { kind: '__unknown__', raw }
  // -------------------------------------------------------------------------

  it('returns { kind: "__unknown__", raw } for an unknown type discriminant', () => {
    const input = { type: 'not_a_real_type', some_field: 42 };
    const event = narrower.narrow(input);

    expect('kind' in event).toBe(true);
    if (!('kind' in event)) throw new Error('Expected UnknownStreamEvent');
    expect(event.kind).toBe('__unknown__');
    expect(event.raw).toEqual(input);
  });

  // -------------------------------------------------------------------------
  // Never throws
  // -------------------------------------------------------------------------

  it('does not throw for completely malformed input (null)', () => {
    expect(() => narrower.narrow(null)).not.toThrow();
    const result = narrower.narrow(null);
    expect('kind' in result).toBe(true);
    if (!('kind' in result)) throw new Error('Expected UnknownStreamEvent');
    expect(result.kind).toBe('__unknown__');
  });

  it('does not throw for a number input', () => {
    expect(() => narrower.narrow(42)).not.toThrow();
  });

  it('does not throw for an empty object', () => {
    expect(() => narrower.narrow({})).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Passthrough — unknown fields survive narrowing
  // -------------------------------------------------------------------------

  it('preserves unknown/extra fields on a known variant (.passthrough() contract)', () => {
    const raw = loadFixture('system_init.json') as Record<string, unknown>;
    const withExtra = { ...raw, future_unannounced_field: 'test-value' };

    const event = narrower.narrow(withExtra);
    expect('kind' in event).toBe(false);
    expect(event).toHaveProperty('future_unannounced_field', 'test-value');
  });

  // -------------------------------------------------------------------------
  // result/success fixture
  // -------------------------------------------------------------------------

  it('narrows result_success.json to result/success variant', () => {
    const raw = loadFixture('result_success.json');
    const event = narrower.narrow(raw);

    expect('kind' in event).toBe(false);
    if ('kind' in event) throw new Error('Expected typed variant');
    expect(event.type).toBe('result');
    if (event.type !== 'result') throw new Error('Expected ResultEvent');
    expect(event.subtype).toBe('success');
    expect(event.is_error).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Multiple calls — no state leakage
  // -------------------------------------------------------------------------

  it('produces consistent results across multiple calls (no internal state)', () => {
    const raw = loadFixture('system_init.json');
    const e1 = narrower.narrow(raw);
    const e2 = narrower.narrow(raw);
    expect(e1).toEqual(e2);
  });
});
