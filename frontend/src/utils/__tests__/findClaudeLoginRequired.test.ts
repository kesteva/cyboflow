import { describe, it, expect } from 'vitest';
import { findClaudeLoginRequired } from '../findClaudeLoginRequired';
import type { UnifiedMessage } from '../../../../shared/types/unifiedMessage';

const user = (text: string): UnifiedMessage => ({
  id: `u-${text}`,
  role: 'user',
  timestamp: '2026-09-15T00:00:00.000Z',
  segments: [{ type: 'text', content: text }],
});
const assistant = (text: string): UnifiedMessage => ({
  id: `a-${text}`,
  role: 'assistant',
  timestamp: '2026-09-15T00:00:01.000Z',
  segments: [{ type: 'text', content: text }],
});
const systemError = (text: string, assistantError?: string): UnifiedMessage => ({
  id: `e-${text}`,
  role: 'system',
  timestamp: '2026-09-15T00:00:02.000Z',
  segments: [{ type: 'text', content: text }],
  metadata: { systemSubtype: 'error', ...(assistantError ? { assistantError } : {}) },
});

describe('findClaudeLoginRequired', () => {
  it('is false on an empty or healthy transcript', () => {
    expect(findClaudeLoginRequired([])).toBe(false);
    expect(findClaudeLoginRequired([user('hi'), assistant('hello')])).toBe(false);
  });

  it('matches the projected is_error RESULT row by text', () => {
    expect(findClaudeLoginRequired([user('hi'), systemError('Error: Not logged in · Please run /login')])).toBe(true);
  });

  it('trusts the SDK structured code even when the text says nothing recognisable', () => {
    expect(findClaudeLoginRequired([user('hi'), systemError('Something opaque', 'authentication_failed')])).toBe(true);
  });

  it('does not match other error rows', () => {
    expect(findClaudeLoginRequired([user('hi'), systemError('Error: Prompt is too long')])).toBe(false);
    expect(findClaudeLoginRequired([user('hi'), systemError('Error: Invalid API key · Fix external API key')])).toBe(false);
  });

  it('only looks at the failure that ended the transcript — a newer user turn clears it', () => {
    expect(
      findClaudeLoginRequired([
        user('hi'),
        systemError('Error: Not logged in · Please run /login'),
        user('trying again'),
        assistant('works now'),
      ]),
    ).toBe(false);
  });

  it('skips trailing non-error system rows to reach the failure', () => {
    const info: UnifiedMessage = {
      id: 's',
      role: 'system',
      timestamp: '2026-09-15T00:00:03.000Z',
      segments: [{ type: 'system_info', info: {} }],
      metadata: { systemSubtype: 'task_complete' },
    };
    expect(findClaudeLoginRequired([user('hi'), systemError('Not logged in · Please run /login'), info])).toBe(true);
  });
});
