/**
 * Unit tests for TypedEventNarrowing.narrow() (TASK-575).
 *
 * Each test constructs a typed SDK-mock object via the shared factory helpers
 * in sdkMockFactories.ts and round-trips it through the narrower. Tests assert
 * variant narrowing, subtype literals, tool_result.content shape duality,
 * .passthrough() field preservation, catch-all behavior on malformed input,
 * and compile-time exhaustive switch coverage via assertNever.
 *
 * All mock objects are synthetic inline values (no on-disk fixture files).
 * See sdkMockFactories.ts for the canonical mock shapes and field values.
 */

import { describe, it, expect } from 'vitest';
import { TypedEventNarrowing } from '../typedEventNarrowing';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';
import { assertNever } from '../../../../../shared/types/claudeStream';
import {
  systemInit,
  systemApiRetry,
  systemCompact,
  assistant,
  userStringContent,
  userArrayContent,
  resultSuccess,
  resultErrorMaxTurns,
  resultErrorMaxBudgetUsd,
  resultErrorDuringExecution,
  streamEvent,
} from './sdkMockFactories';

// Shared narrower — no logger (silent narrow, same never-throw contract)
const narrower = new TypedEventNarrowing();

// ---------------------------------------------------------------------------
// SystemInitEvent
// ---------------------------------------------------------------------------

describe('SystemInitEvent', () => {
  it('parses system_init.json and narrows to system/init with all required fields', () => {
    const raw = systemInit();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('system');
    // Narrow to system/init branch
    if (event.type !== 'system' || event.subtype !== 'init') {
      throw new Error('Expected SystemInitEvent');
    }
    expect(event.subtype).toBe('init');
    expect(typeof event.session_id).toBe('string');
    expect(typeof event.cwd).toBe('string');
    expect(typeof event.model).toBe('string');
    expect(Array.isArray(event.tools)).toBe(true);
  });

  it('system_init.json exposes permissionMode in camelCase (wire-spec exception), not permission_mode', () => {
    const raw = systemInit();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    // permissionMode is the documented camelCase wire exception (SamSaffron spec gist)
    expect(Object.keys(event)).toContain('permissionMode');
    expect(event).not.toHaveProperty('permission_mode');
  });
});

// ---------------------------------------------------------------------------
// SystemApiRetryEvent
// ---------------------------------------------------------------------------

describe('SystemApiRetryEvent', () => {
  it('parses system_api_retry.json and narrows to system/api_retry with numeric retry fields', () => {
    const raw = systemApiRetry();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('system');
    if (event.type !== 'system' || event.subtype !== 'api_retry') {
      throw new Error('Expected SystemApiRetryEvent');
    }
    expect(event.subtype).toBe('api_retry');
    expect(typeof event.attempt).toBe('number');
    expect(typeof event.max_retries).toBe('number');
    expect(typeof event.retry_delay_ms).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// SystemCompactEvent
// ---------------------------------------------------------------------------

describe('SystemCompactEvent', () => {
  it('parses system_compact.json and narrows to system/compact — pins the wire literal (not context_compacted)', () => {
    // NOTE: Crystal's ClaudeMessageTransformer uses 'context_compacted' internally,
    // but the actual wire discriminant is 'compact' per research §1. This test
    // pins the wire literal so that any CLI update changing the wire value fails loudly.
    const raw = systemCompact();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('system');
    if (event.type !== 'system' || event.subtype !== 'compact') {
      throw new Error('Expected SystemCompactEvent');
    }
    expect(event.subtype).toBe('compact');
  });
});

// ---------------------------------------------------------------------------
// AssistantEvent
// ---------------------------------------------------------------------------

describe('AssistantEvent', () => {
  it('parses assistant.json and narrows to assistant with mixed content array (text + tool_use)', () => {
    const raw = assistant();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('assistant');
    if (event.type !== 'assistant') {
      throw new Error('Expected AssistantEvent');
    }

    const content = event.message.content;
    expect(Array.isArray(content)).toBe(true);

    // Mixed-content case from research §1 §3: content array has both text and tool_use blocks
    const hasTextBlock = content.some((block) => block.type === 'text');
    const hasToolUseBlock = content.some((block) => block.type === 'tool_use');
    expect(hasTextBlock).toBe(true);
    expect(hasToolUseBlock).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UserEvent (string content + array content duality)
// ---------------------------------------------------------------------------

describe('UserEvent', () => {
  it('parses user_string_content.json — tool_result.content is a plain string', () => {
    const raw = userStringContent();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('user');
    if (event.type !== 'user') {
      throw new Error('Expected UserEvent from user_string_content fixture');
    }

    const toolResult = event.message.content[0];
    expect(toolResult.type).toBe('tool_result');
    // Research §1 §4: content can be a plain string — this fixture tests the string form
    expect(typeof toolResult.content).toBe('string');
  });

  it('parses user_array_content.json — tool_result.content is an array of {type, text} objects', () => {
    const raw = userArrayContent();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('user');
    if (event.type !== 'user') {
      throw new Error('Expected UserEvent from user_array_content fixture');
    }

    const toolResult = event.message.content[0];
    expect(toolResult.type).toBe('tool_result');
    // Research §1 §4: content can be an array [{type, text}] — this fixture tests the array form
    expect(Array.isArray(toolResult.content)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ResultEvent (all 4 subtypes)
// ---------------------------------------------------------------------------

describe('ResultEvent', () => {
  it('parses result_success.json and asserts subtype === "success"', () => {
    const raw = resultSuccess();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('result');
    if (event.type !== 'result') {
      throw new Error('Expected ResultEvent');
    }
    expect(event.subtype).toBe('success');
    expect(event.is_error).toBe(false);
  });

  it('parses result_error_max_turns.json and asserts subtype === "error_max_turns"', () => {
    const raw = resultErrorMaxTurns();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('result');
    if (event.type !== 'result') {
      throw new Error('Expected ResultEvent');
    }
    expect(event.subtype).toBe('error_max_turns');
    expect(event.is_error).toBe(true);
  });

  it('parses result_error_max_budget_usd.json and asserts subtype === "error_max_budget_usd"', () => {
    const raw = resultErrorMaxBudgetUsd();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('result');
    if (event.type !== 'result') {
      throw new Error('Expected ResultEvent');
    }
    expect(event.subtype).toBe('error_max_budget_usd');
    expect(event.is_error).toBe(true);
  });

  it('parses result_error_during_execution.json and asserts subtype === "error_during_execution"', () => {
    const raw = resultErrorDuringExecution();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('result');
    if (event.type !== 'result') {
      throw new Error('Expected ResultEvent');
    }
    expect(event.subtype).toBe('error_during_execution');
    expect(event.is_error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StreamEvent
// ---------------------------------------------------------------------------

describe('StreamEvent', () => {
  it('parses stream_event.json and narrows to stream_event with nested event.type string', () => {
    const raw = streamEvent();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('stream_event');
    if (event.type !== 'stream_event') {
      throw new Error('Expected StreamEvent');
    }
    expect(typeof event.event.type).toBe('string');
    // Factory uses content_block_delta — confirm it's a real stream event type
    expect(event.event.type).toBe('content_block_delta');
  });
});

// ---------------------------------------------------------------------------
// UnknownStreamEvent fallback — catch-all behavior on malformed input
// ---------------------------------------------------------------------------

describe('UnknownStreamEvent fallback', () => {
  it('returns __unknown__ for payload with type: never_seen_before (unknown variant)', () => {
    const input = { type: 'never_seen_before', foo: 'bar' };
    expect(() => narrower.narrow(input)).not.toThrow();
    const result = narrower.narrow(input);
    // Catch-all: unknown variant routes to { kind: '__unknown__', raw: ... }
    expect(result).toHaveProperty('kind', '__unknown__');
    if (!('kind' in result) || result.kind !== '__unknown__') {
      throw new Error('Expected UnknownStreamEvent');
    }
    expect(result.raw).toEqual(input);
  });

  it('returns __unknown__ for missing type field (malformed object)', () => {
    const input = { foo: 'bar' };
    expect(() => narrower.narrow(input)).not.toThrow();
    const result = narrower.narrow(input);
    expect(result).toHaveProperty('kind', '__unknown__');
  });

  it('returns __unknown__ for primitives and malformed input (null, number, string)', () => {
    // All primitives must return __unknown__ without throwing
    const nullResult = narrower.narrow(null);
    expect(nullResult).toHaveProperty('kind', '__unknown__');

    const numberResult = narrower.narrow(42);
    expect(numberResult).toHaveProperty('kind', '__unknown__');

    const stringResult = narrower.narrow('string');
    expect(stringResult).toHaveProperty('kind', '__unknown__');

    expect(() => narrower.narrow(null)).not.toThrow();
    expect(() => narrower.narrow(42)).not.toThrow();
    expect(() => narrower.narrow('string')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Passthrough preservation — unknown fields survive parsing
// ---------------------------------------------------------------------------

describe('passthrough', () => {
  it('preserves an unknown field (future_unannounced_field) when added to a known fixture', () => {
    // Mutate a copy of system_init to add a hypothetical future field.
    // The Zod schema uses .passthrough() so unknown fields are carried through.
    const mutated = { ...systemInit(), future_unannounced_field: 'lorem' };

    expect(() => narrower.narrow(mutated)).not.toThrow();
    const event = narrower.narrow(mutated);

    // The unknown field must be preserved on the parsed object (not stripped)
    expect(event).toHaveProperty('future_unannounced_field', 'lorem');

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    // Confirm it still parsed as the correct variant (not degraded to __unknown__)
    expect(event.type).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// Exhaustive union coverage — compile-time tripwire via assertNever
// ---------------------------------------------------------------------------

describe('exhaustive union coverage', () => {
  it('summarize() covers every ClaudeStreamEvent variant — assertNever fails to compile if union grows without a new case', () => {
    // Type guard that narrows away UnknownStreamEvent from the full union.
    type KnownStreamEvent = Exclude<ClaudeStreamEvent, { kind: '__unknown__' }>;
    function isKnown(event: ClaudeStreamEvent): event is KnownStreamEvent {
      return !('kind' in event);
    }

    function summarize(event: ClaudeStreamEvent): string {
      // Handle UnknownStreamEvent BEFORE the switch — its discriminant is `kind`, not `type`,
      // so a switch on `event.type` would not compile if UnknownStreamEvent were in scope.
      if (!isKnown(event)) return 'unknown';
      switch (event.type) {
        case 'system': return `system/${event.subtype}`;
        case 'assistant': return 'assistant';
        case 'user': return 'user';
        case 'result': return `result/${event.subtype}`;
        case 'stream_event': return 'stream_event';
        default:
          // If a new variant is added to ClaudeStreamEvent without being handled here,
          // tsc --noEmit will fail to compile this line — the assertNever tripwire.
          return assertNever(event);
      }
    }

    // Run summarize against every factory and assert non-empty return values.
    // The runtime assertion is incidental; the load-bearing check is the assertNever
    // call that only typechecks if the union is fully covered.
    const fixtures: Array<[ClaudeStreamEvent, string]> = [
      [systemInit(), 'system/init'],
      [systemApiRetry(), 'system/api_retry'],
      [systemCompact(), 'system/compact'],
      [assistant(), 'assistant'],
      [userStringContent(), 'user'],
      [userArrayContent(), 'user'],
      [resultSuccess(), 'result/success'],
      [resultErrorMaxTurns(), 'result/error_max_turns'],
      [resultErrorMaxBudgetUsd(), 'result/error_max_budget_usd'],
      [resultErrorDuringExecution(), 'result/error_during_execution'],
      [streamEvent(), 'stream_event'],
    ];

    for (const [mockEvent, expectedSummary] of fixtures) {
      const event = narrower.narrow(mockEvent);
      const summary = summarize(event);
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).toBe(expectedSummary);
    }

    // Also confirm catch-all (unknown) routes correctly
    const unknown = narrower.narrow({ type: 'never_seen_before' });
    expect(summarize(unknown)).toBe('unknown');
  });
});
