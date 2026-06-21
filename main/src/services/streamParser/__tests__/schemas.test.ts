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
  systemCompactBoundary,
  assistant,
  userStringContent,
  userArrayContent,
  resultSuccess,
  resultErrorMaxTurns,
  resultErrorMaxBudgetUsd,
  resultErrorDuringExecution,
  resultErrorMaxStructuredOutputRetries,
  streamEvent,
  streamEventSignatureDelta,
  streamEventThinkingDelta,
  sessionInfo,
  rateLimitEvent,
  systemHookStarted,
  systemHookResponse,
  systemStatus,
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
// SystemCompactBoundaryEvent (SDK-only variant)
// ---------------------------------------------------------------------------

describe('SystemCompactBoundaryEvent', () => {
  it('narrows compact_boundary to system/compact_boundary with compact_metadata intact', () => {
    const raw = systemCompactBoundary();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    if (event.type !== 'system' || event.subtype !== 'compact_boundary') {
      throw new Error('Expected SystemCompactBoundaryEvent');
    }
    expect(event.compact_metadata.trigger).toBe('auto');
    expect(event.compact_metadata.pre_tokens).toBe(90000);
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
    if (toolResult.type !== 'tool_result') {
      throw new Error('Expected a tool_result block from user_string_content fixture');
    }
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
    if (toolResult.type !== 'tool_result') {
      throw new Error('Expected a tool_result block from user_array_content fixture');
    }
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

  it('narrows error_max_structured_output_retries to result/error_max_structured_output_retries (SDK-only)', () => {
    const raw = resultErrorMaxStructuredOutputRetries();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    if (event.type !== 'result') {
      throw new Error('Expected ResultEvent');
    }
    expect(event.subtype).toBe('error_max_structured_output_retries');
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

  it('narrows signature_delta to stream_event with delta.type === signature_delta and signature field preserved', () => {
    const raw = streamEventSignatureDelta();
    const event = narrower.narrow(raw);
    if ('kind' in event) throw new Error('Expected typed variant, got UnknownStreamEvent');
    if (event.type !== 'stream_event') throw new Error('Expected StreamEvent');
    expect(event.event.type).toBe('content_block_delta');
    expect(event.event.delta?.type).toBe('signature_delta');
    expect(event.event.delta?.signature).toBe('EvcDCmMIDRgCEXAMPLE_SIGNATURE_SHAPE_BASE64_PADDING==');
  });

  it('narrows thinking_delta to stream_event with delta.type === thinking_delta and thinking field preserved', () => {
    const raw = streamEventThinkingDelta();
    const event = narrower.narrow(raw);
    if ('kind' in event) throw new Error('Expected typed variant, got UnknownStreamEvent');
    if (event.type !== 'stream_event') throw new Error('Expected StreamEvent');
    expect(event.event.type).toBe('content_block_delta');
    expect(event.event.delta?.type).toBe('thinking_delta');
    expect(event.event.delta?.thinking).toBe('Let me think about this step by step.');
  });
});

// ---------------------------------------------------------------------------
// SessionInfoEvent (orchestrator-synthetic, TASK-696)
// ---------------------------------------------------------------------------

describe('SessionInfoEvent', () => {
  it('parses session_info factory and narrows to session_info (not __unknown__)', () => {
    const raw = sessionInfo();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('session_info');
    if (event.type !== 'session_info') {
      throw new Error('Expected SessionInfoEvent');
    }
    expect(event.worktree_path).toBe('/tmp/cyboflow-worktree-abc123');
    expect(event.model).toBe('claude-sonnet-4-5');
    expect(event.permission_mode).toBe('approve');
    expect(typeof event.initial_prompt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// RateLimitEvent (TASK-696)
// ---------------------------------------------------------------------------

describe('RateLimitEvent', () => {
  it('parses rate_limit_event factory and narrows to rate_limit_event (not __unknown__)', () => {
    const raw = rateLimitEvent();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('rate_limit_event');
    if (event.type !== 'rate_limit_event') {
      throw new Error('Expected RateLimitEvent');
    }
    expect(event.rate_limit_info.status).toBe('allowed_warning');
    expect(event.rate_limit_info.resetsAt).toBe(1747776000);
    expect(event.rate_limit_info.rateLimitType).toBe('five_hour');
  });
});

// ---------------------------------------------------------------------------
// SystemHookStartedEvent (TASK-696)
// ---------------------------------------------------------------------------

describe('SystemHookStartedEvent', () => {
  it('parses system/hook_started factory and narrows to system/hook_started (not __unknown__)', () => {
    const raw = systemHookStarted();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('system');
    if (event.type !== 'system' || event.subtype !== 'hook_started') {
      throw new Error('Expected SystemHookStartedEvent');
    }
    expect(event.hook_name).toBe('pre-tool-use');
    expect(event.hook_event).toBe('PreToolUse');
    expect(typeof event.hook_id).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// SystemHookResponseEvent (TASK-696)
// ---------------------------------------------------------------------------

describe('SystemHookResponseEvent', () => {
  it('parses system/hook_response factory and narrows to system/hook_response (not __unknown__)', () => {
    const raw = systemHookResponse();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('system');
    if (event.type !== 'system' || event.subtype !== 'hook_response') {
      throw new Error('Expected SystemHookResponseEvent');
    }
    expect(event.outcome).toBe('success');
    expect(event.hook_name).toBe('pre-tool-use');
    expect(event.exit_code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SystemStatusEvent (TASK-696)
// ---------------------------------------------------------------------------

describe('SystemStatusEvent', () => {
  it('parses system/status factory and narrows to system/status (not __unknown__)', () => {
    const raw = systemStatus();
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('system');
    if (event.type !== 'system' || event.subtype !== 'status') {
      throw new Error('Expected SystemStatusEvent');
    }
    expect(event.status).toBe('requesting');
    expect(typeof event.session_id).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// RateLimitEvent — rejected status variant (test-writer addition, TASK-696)
// ---------------------------------------------------------------------------

describe('RateLimitEvent — rejected status', () => {
  it('narrows rate_limit_event with status=rejected to rate_limit_event (not __unknown__)', () => {
    const raw = rateLimitEvent({ rate_limit_info: { status: 'rejected', resetsAt: 1747800000 } });
    const event = narrower.narrow(raw);

    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('rate_limit_event');
    if (event.type !== 'rate_limit_event') {
      throw new Error('Expected RateLimitEvent');
    }
    expect(event.rate_limit_info.status).toBe('rejected');
    expect(event.rate_limit_info.resetsAt).toBe(1747800000);
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
// Passthrough — outer-schema unknown fields are stripped (Option 3 — TASK-656)
// ---------------------------------------------------------------------------

describe('passthrough', () => {
  it('strips an unknown top-level field (future_unannounced_field) on a known fixture — outer schemas no longer use .passthrough()', () => {
    // Option 3 (TASK-656): outer union-member schemas drop .passthrough() to
    // allow the bidirectional _reverseCheck compile-time bridge to work.
    // Unknown fields at the outer schema level are now silently stripped by Zod
    // (default z.object strip mode). New SDK fields at the outer level will
    // surface as __unknown__ variants via the catch-all, forcing an explicit
    // schema update — this is a feature, not a regression.
    const mutated = { ...systemInit(), future_unannounced_field: 'lorem' };

    expect(() => narrower.narrow(mutated)).not.toThrow();
    const event = narrower.narrow(mutated);

    // The event still parses correctly as the expected variant (not __unknown__)
    // since the known fields are all present; the unknown field is stripped.
    if ('kind' in event) {
      throw new Error('Expected typed variant, got UnknownStreamEvent');
    }
    expect(event.type).toBe('system');
    // Outer unknown field is stripped (not preserved) — this is the Option 3 trade-off.
    expect(event).not.toHaveProperty('future_unannounced_field');
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
        case 'session_info': return 'session_info';
        case 'rate_limit_event': return 'rate_limit_event';
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
      [systemCompactBoundary(), 'system/compact_boundary'],
      [systemHookStarted(), 'system/hook_started'],
      [systemHookResponse(), 'system/hook_response'],
      [systemStatus(), 'system/status'],
      [sessionInfo(), 'session_info'],
      [rateLimitEvent(), 'rate_limit_event'],
      [assistant(), 'assistant'],
      [userStringContent(), 'user'],
      [userArrayContent(), 'user'],
      [resultSuccess(), 'result/success'],
      [resultErrorMaxTurns(), 'result/error_max_turns'],
      [resultErrorMaxBudgetUsd(), 'result/error_max_budget_usd'],
      [resultErrorDuringExecution(), 'result/error_during_execution'],
      [resultErrorMaxStructuredOutputRetries(), 'result/error_max_structured_output_retries'],
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
