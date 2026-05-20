import { describe, it, expect } from 'vitest';
import { parseJsonMessage, parseJsonMessages } from '../parseJsonMessage';
import type { ClaudeJsonMessage } from '../../../../types/session';

describe('parseJsonMessage', () => {
  it('returns a normalized JSONMessage for a raw message with stringified data', () => {
    const raw = { type: 'assistant', timestamp: '2026-05-18T10:00:00Z', data: '{"hello":"world"}' } as unknown as ClaudeJsonMessage;
    const parsed = parseJsonMessage(raw);
    expect(parsed).toEqual({ type: 'json', data: '{"hello":"world"}', timestamp: '2026-05-18T10:00:00Z' });
  });

  it('returns a UserPromptMessage when raw.type=user and message.content is a text array', () => {
    const raw = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      timestamp: '2026-05-18T10:00:00Z',
    } as ClaudeJsonMessage;
    const parsed = parseJsonMessage(raw);
    expect(parsed?.type).toBe('user');
  });

  it('discriminates session_info', () => {
    const raw = { data: '{"type":"session_info","timestamp":"x"}' } as unknown as ClaudeJsonMessage;
    const parsed = parseJsonMessage(raw);
    expect(parsed?.type).toBe('session_info');
  });

  it('returns null for a message with no timestamp and no parseable data', () => {
    const raw = { type: 'assistant' } as ClaudeJsonMessage;
    const parsed = parseJsonMessage(raw);
    expect(parsed).toBeNull();
  });

  it('parseJsonMessages drops nulls and returns an array', () => {
    const out = parseJsonMessages([
      { type: 'assistant', timestamp: 't', data: '{"a":1}' } as unknown as ClaudeJsonMessage,
      { type: 'assistant' } as ClaudeJsonMessage, // null-producing
    ]);
    expect(out).toHaveLength(1);
  });
});
