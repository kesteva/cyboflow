/**
 * Unit tests for TypedEventNarrowing.
 *
 * Covers: known event types narrow to their tagged variant; unknown
 * discriminants fall through to { kind: '__unknown__', raw }; no throws;
 * passthrough fields survive; the system/init and assistant/tool_use factories
 * are used as real-world inputs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TypedEventNarrowing } from '../typedEventNarrowing';
import { claudeStreamEventSchema, claudeStreamEventSchemaByType } from '../schemas';
import {
  systemInit,
  assistant,
  resultSuccess,
  streamEventSignatureDelta,
  streamEventThinkingDelta,
} from './sdkMockFactories';

describe('TypedEventNarrowing', () => {
  let narrower: TypedEventNarrowing;

  beforeEach(() => {
    narrower = new TypedEventNarrowing();
  });

  // -------------------------------------------------------------------------
  // system/init factory — narrows to SystemInitEvent
  // -------------------------------------------------------------------------

  it('narrows system_init.json to system/init variant', () => {
    const raw = systemInit();
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
  // assistant/tool_use factory — narrows to AssistantEvent
  // -------------------------------------------------------------------------

  it('narrows assistant.json (with tool_use block) to assistant variant', () => {
    const raw = assistant();
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
  // Strip behavior — outer-schema unknown fields are stripped (Option 3 — TASK-656)
  // -------------------------------------------------------------------------

  it('strips unknown/extra top-level fields on a known variant (outer schemas use strip mode after TASK-656)', () => {
    const withExtra = { ...systemInit(), future_unannounced_field: 'test-value' };

    const event = narrower.narrow(withExtra);
    // Event still narrows to the correct typed variant (not __unknown__)
    expect('kind' in event).toBe(false);
    // Outer unknown field is stripped — Option 3 trade-off (TASK-656)
    expect(event).not.toHaveProperty('future_unannounced_field');
  });

  // -------------------------------------------------------------------------
  // result/success factory
  // -------------------------------------------------------------------------

  it('narrows result_success.json to result/success variant', () => {
    const raw = resultSuccess();
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
    const raw = systemInit();
    const e1 = narrower.narrow(raw);
    const e2 = narrower.narrow(raw);
    expect(e1).toEqual(e2);
  });

  // -------------------------------------------------------------------------
  // signature_delta / thinking_delta — regression test for 2026-05-22 live finding
  // -------------------------------------------------------------------------

  it('narrows content_block_delta with delta.type signature_delta or thinking_delta to stream_event (not __unknown__) — regression test for live-testing finding 2026-05-22', () => {
    const signatureEvent = narrower.narrow(streamEventSignatureDelta());
    expect('kind' in signatureEvent).toBe(false);
    if ('kind' in signatureEvent) throw new Error('signature_delta narrowed to __unknown__');
    expect(signatureEvent.type).toBe('stream_event');
    if (signatureEvent.type !== 'stream_event') throw new Error('Expected StreamEvent');
    expect(signatureEvent.event.delta?.type).toBe('signature_delta');

    const thinkingEvent = narrower.narrow(streamEventThinkingDelta());
    expect('kind' in thinkingEvent).toBe(false);
    if ('kind' in thinkingEvent) throw new Error('thinking_delta narrowed to __unknown__');
    expect(thinkingEvent.type).toBe('stream_event');
    if (thinkingEvent.type !== 'stream_event') throw new Error('Expected StreamEvent');
    expect(thinkingEvent.event.delta?.type).toBe('thinking_delta');
  });

  // -------------------------------------------------------------------------
  // MCP tool_result user event — regression test for the global-agent transcript
  // -------------------------------------------------------------------------

  it('narrows a user tool_result event whose tool_use_result is an ARRAY (MCP shape) to the user variant, not __unknown__', () => {
    // Verbatim shape observed in agent_thread_events: an MCP tool result carries
    // `tool_use_result` as an array of content blocks, not the file-tool metadata
    // object. Modelling only the object arm demoted every one of these to
    // { kind: '__unknown__' }, so the tool's result vanished from the transcript.
    const raw = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01FqtmdyMPD2ddeG46qoLCG2',
            content: [{ type: 'text', text: '{"projects":[]}' }],
          },
        ],
      },
      tool_use_result: [{ type: 'text', text: '{"projects":[]}' }],
      parent_tool_use_id: null,
      session_id: 'd42c1de3-6218-4698-8f3e-46491acd17e2',
    };

    const event = narrower.narrow(raw);
    expect('kind' in event).toBe(false);
    if ('kind' in event) throw new Error('MCP tool_result user event narrowed to __unknown__');
    expect(event.type).toBe('user');
    if (event.type !== 'user') throw new Error('Expected UserEvent');
    expect(event.message.content[0].type).toBe('tool_result');
  });

  // -------------------------------------------------------------------------
  // Image tool_result content block — regression test for the dropped-
  // screenshot defect (image blocks carry no `text` field)
  // -------------------------------------------------------------------------

  it('narrows a user tool_result event whose content array includes an image block to the user variant, not __unknown__', () => {
    // Verbatim shape a tool_result carries when a tool returns an image (e.g. a
    // visual-verification screenshot): a base64-embedded block with no `text`
    // field. The old array-arm schema required `text: z.string()` on every
    // element, so this block was rejected outright, demoting the whole `user`
    // event to `{ kind: '__unknown__' }` and dropping it from the transcript.
    const raw = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_011TZjjfBovjdqjSbh7vMdH1',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
              },
            ],
          },
        ],
      },
    };

    const event = narrower.narrow(raw);
    expect('kind' in event).toBe(false);
    if ('kind' in event) throw new Error('Image tool_result user event narrowed to __unknown__');
    expect(event.type).toBe('user');
    if (event.type !== 'user') throw new Error('Expected UserEvent');
    const block = event.message.content[0];
    expect(block.type).toBe('tool_result');
    if (block.type !== 'tool_result') throw new Error('Expected ToolResultBlock');
    expect(Array.isArray(block.content)).toBe(true);
    if (!Array.isArray(block.content)) throw new Error('Expected array content');
    expect(block.content[0].type).toBe('image');
  });

  it('narrows a user tool_result event whose content array mixes text and image blocks to the user variant', () => {
    const raw = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_mixedBlockTypes01',
            content: [
              { type: 'text', text: 'here is the screenshot' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
              },
            ],
          },
        ],
      },
    };

    const event = narrower.narrow(raw);
    expect('kind' in event).toBe(false);
    if ('kind' in event) throw new Error('Mixed-block tool_result user event narrowed to __unknown__');
    expect(event.type).toBe('user');
    if (event.type !== 'user') throw new Error('Expected UserEvent');
    const block = event.message.content[0];
    if (block.type !== 'tool_result') throw new Error('Expected ToolResultBlock');
    expect(Array.isArray(block.content)).toBe(true);
    if (!Array.isArray(block.content)) throw new Error('Expected array content');
    expect(block.content.map((b) => b.type)).toEqual(['text', 'image']);
  });

  // -------------------------------------------------------------------------
  // Pre-existing tool_result content shapes — non-regression: plain string and
  // plain text-block-array content must keep narrowing exactly as before.
  // -------------------------------------------------------------------------

  it('still narrows a user tool_result event whose content is a plain string', () => {
    const raw = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_plainStringContent01',
            content: 'plain string tool result',
          },
        ],
      },
    };

    const event = narrower.narrow(raw);
    expect('kind' in event).toBe(false);
    if ('kind' in event) throw new Error('Plain-string tool_result user event narrowed to __unknown__');
    expect(event.type).toBe('user');
    if (event.type !== 'user') throw new Error('Expected UserEvent');
    const block = event.message.content[0];
    if (block.type !== 'tool_result') throw new Error('Expected ToolResultBlock');
    expect(block.content).toBe('plain string tool result');
  });

  it('still narrows a user tool_result event whose content is a plain text-block array', () => {
    const raw = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_textBlockArray01',
            content: [{ type: 'text', text: 'ordinary text-only tool result' }],
          },
        ],
      },
    };

    const event = narrower.narrow(raw);
    expect('kind' in event).toBe(false);
    if ('kind' in event) throw new Error('Text-block-array tool_result user event narrowed to __unknown__');
    expect(event.type).toBe('user');
    if (event.type !== 'user') throw new Error('Expected UserEvent');
    const block = event.message.content[0];
    if (block.type !== 'tool_result') throw new Error('Expected ToolResultBlock');
    expect(Array.isArray(block.content)).toBe(true);
    if (!Array.isArray(block.content)) throw new Error('Expected array content');
    expect(block.content[0]).toEqual({ type: 'text', text: 'ordinary text-only tool result' });
  });

  // -------------------------------------------------------------------------
  // Background-task lifecycle system events
  // -------------------------------------------------------------------------

  it('narrows system/task_notification to the system variant, not __unknown__', () => {
    // Verbatim shape observed in raw_events. Modelling only init/compact_boundary/
    // hook_*/status demoted every task_* event to { kind: '__unknown__' }, so a
    // backgrounded sub-agent's FINAL REPORT (carried in `summary`) never reached
    // the projection and rendered nowhere.
    const raw = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'a4aff561826d6af1d',
      tool_use_id: 'toolu_01Kg1f8DZg7qmL4T941zw7eL',
      status: 'completed',
      output_file: '/tmp/tasks/a4aff561826d6af1d.output',
      summary: '## Dependencies\n\nTASK-108 depends on TASK-107.',
      usage: { total_tokens: 57286, tool_uses: 6, duration_ms: 17830 },
      uuid: '563f32e5-c75e-4b1a-9f3a-8d2e1c4b7a90',
      session_id: '074ba29b-36b0-4389-b75c-e1f964a46c42',
    };

    const event = narrower.narrow(raw);
    expect('kind' in event).toBe(false);
    if ('kind' in event) throw new Error('task_notification narrowed to __unknown__');
    if (event.type !== 'system' || event.subtype !== 'task_notification') {
      throw new Error('Expected SystemTaskNotificationEvent');
    }
    expect(event.summary).toContain('TASK-108 depends on TASK-107');
    expect(event.status).toBe('completed');
  });

  it('narrows system/task_started and system/task_updated to the system variant', () => {
    const started = narrower.narrow({
      type: 'system',
      subtype: 'task_started',
      task_id: 'b48iau5q5',
      tool_use_id: 'toolu_01UKGFjnFervr56MbWGBbSQJ',
      description: 'Locate soloflow plugin root',
      task_type: 'local_bash',
      uuid: '8f9587fa-2941-4f6c-8db4-38e57098088b',
      session_id: '9ac69ae6-7b4a-4007-b470-b6c9628dfb71',
    });
    expect('kind' in started).toBe(false);

    const updated = narrower.narrow({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'b48iau5q5',
      patch: { is_backgrounded: true },
      uuid: 'b6d30dcf-7782-45a1-94bb-8a326bec46d1',
      session_id: '9ac69ae6-7b4a-4007-b470-b6c9628dfb71',
    });
    expect('kind' in updated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Union equivalence
  //
  // narrow() dispatches on the top-level `type` and parses ONE branch instead
  // of walking the whole z.union, because Zod builds a ZodError for every
  // non-matching branch and that dominated main-process CPU while runs streamed.
  // These pin the two properties that make the swap safe: the dispatch map
  // covers exactly the union's branches, and it accepts/rejects the same values.
  // -------------------------------------------------------------------------

  it('dispatch map covers exactly the top-level types the union accepts', () => {
    expect(Object.keys(claudeStreamEventSchemaByType).sort()).toEqual([
      'assistant',
      'rate_limit_event',
      'result',
      'session_info',
      'stream_event',
      'system',
      'user',
    ]);
  });

  it('maps each key to the branch that actually pins that literal', () => {
    // Key coverage alone is not enough: swapping two map values would keep both
    // the key list and the compile-time output-union bridges satisfied while
    // silently routing every event of those two types to the wrong schema.
    // Read each branch's DECLARED `type` literal and require it to equal its key.
    interface LiteralLike { value: unknown }
    interface ObjectLike { shape: { type: LiteralLike } }
    interface UnionLike { options: ObjectLike[] }

    const declaredTypes = (branch: unknown): unknown[] => {
      if (typeof branch !== 'object' || branch === null) return [];
      if ('options' in branch) {
        return (branch as UnionLike).options.map((option) => option.shape.type.value);
      }
      if ('shape' in branch) return [(branch as ObjectLike).shape.type.value];
      return [];
    };

    for (const [key, branch] of Object.entries(claudeStreamEventSchemaByType)) {
      const literals = declaredTypes(branch);
      expect(literals.length).toBeGreaterThan(0);
      // Every arm of a branch (a subtype-discriminated union has several) must
      // pin the same top-level `type`, and it must be the key it is filed under.
      for (const literal of literals) expect(literal).toBe(key);
    }
  });

  it('returns __unknown__ (never throws) for prototype-named event types', () => {
    // `'constructor' in obj` is true via Object.prototype, so an object-index
    // guard would pass and then call `.safeParse` on Object itself — a TypeError
    // out of a function documented to NEVER throw. Ordinary JSON can carry these.
    for (const type of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const event = JSON.parse(JSON.stringify({ type, anything: 1 })) as unknown;
      let result: ReturnType<TypedEventNarrowing['narrow']> | undefined;
      expect(() => { result = narrower.narrow(event); }).not.toThrow();
      expect(result && 'kind' in result && result.kind).toBe('__unknown__');
    }
  });

  it('narrows every content-block kind, and rejects an unknown or malformed one', () => {
    // contentBlockSchema is a discriminatedUnion parsed once PER BLOCK, so this
    // pins that all three arms still narrow and that a bad block still sinks the
    // whole event to __unknown__ (rather than being silently dropped or kept).
    const withBlocks = (content: unknown[]) => ({
      type: 'assistant',
      message: {
        id: 'm1', type: 'message', role: 'assistant', model: 'claude',
        content, stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      session_id: 'sess', uuid: 'u1',
    });

    const ok = narrower.narrow(withBlocks([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'thinking', thinking: 'hmm' },
    ]));
    expect('kind' in ok).toBe(false);

    // Unknown discriminant.
    const unknownBlock = narrower.narrow(withBlocks([{ type: 'image', source: {} }]));
    expect('kind' in unknownBlock && unknownBlock.kind).toBe('__unknown__');

    // Known discriminant, wrong payload — must NOT slip through.
    const malformed = narrower.narrow(withBlocks([{ type: 'text', text: 42 }]));
    expect('kind' in malformed && malformed.kind).toBe('__unknown__');
  });

  it('agrees with the full union on both accepted and rejected values', () => {
    const corpus: unknown[] = [
      systemInit(),
      assistant(),
      resultSuccess(),
      streamEventSignatureDelta(),
      streamEventThinkingDelta(),
      // Rejected: unknown discriminant, missing discriminant, wrong shape for a
      // KNOWN type, non-object, and a null/absent type.
      { type: 'totally_unknown', foo: 1 },
      { subtype: 'init' },
      { type: 'assistant' },
      { type: 'result', subtype: 'success' },
      'not-an-object',
      42,
      null,
      { type: null },
      // Prototype-reachable names: the old union rejected these, and so must the
      // dispatch path (rather than resolving to Object.prototype members).
      { type: 'constructor' },
      { type: 'toString' },
      { type: 'valueOf' },
      { type: 'hasOwnProperty' },
      // Non-string discriminants.
      { type: 1 },
      { type: { toString: () => 'assistant' } },
      [],
    ];

    for (const value of corpus) {
      const viaUnion = claudeStreamEventSchema.safeParse(value);
      const viaNarrow = narrower.narrow(value);
      const narrowRejected = 'kind' in viaNarrow && viaNarrow.kind === '__unknown__';
      expect(narrowRejected).toBe(!viaUnion.success);
      if (viaUnion.success) {
        expect(viaNarrow).toEqual(viaUnion.data);
      }
    }
  });

  // -------------------------------------------------------------------------
  // assistant.error as a bare string code (SDKAssistantMessageError)
  // -------------------------------------------------------------------------

  it('narrows an assistant event whose error is a string code instead of dropping it', () => {
    const raw = {
      type: 'assistant',
      message: {
        id: 'msg_auth',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
      },
      parent_tool_use_id: null,
      session_id: 'sess-1',
      uuid: 'uuid-1',
      error: 'authentication_failed',
    };
    const event = narrower.narrow(raw);
    expect('kind' in event).toBe(false);
    if ('kind' in event) throw new Error('Expected typed variant');
    if (event.type !== 'assistant') throw new Error('Expected AssistantEvent');
    expect(event.error).toBe('authentication_failed');
  });

  it('still narrows the legacy object form of assistant.error', () => {
    const raw = {
      type: 'assistant',
      message: {
        id: 'msg_legacy',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'API Error: boom' }],
      },
      error: { message: 'boom' },
    };
    const event = narrower.narrow(raw);
    if ('kind' in event) throw new Error('Expected typed variant');
    if (event.type !== 'assistant') throw new Error('Expected AssistantEvent');
    expect(event.error).toEqual({ message: 'boom' });
  });
});
