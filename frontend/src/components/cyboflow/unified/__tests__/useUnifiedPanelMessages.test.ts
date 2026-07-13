import { describe, expect, it } from 'vitest';
import type { UnifiedMessage } from '../../../../../../shared/types/unifiedMessage';
import { mergePanelMessageSources } from '../useUnifiedPanelMessages';

function user(id: string, text: string, timestamp: string): UnifiedMessage {
  return {
    id,
    role: 'user',
    timestamp,
    segments: [{ type: 'text', content: text }],
  };
}

function assistant(id: string, text: string, timestamp: string): UnifiedMessage {
  return {
    id,
    role: 'assistant',
    timestamp,
    segments: [{ type: 'text', content: text }],
  };
}

describe('mergePanelMessageSources', () => {
  it('prefers one projected Codex user turn over duplicate conversation rows', () => {
    const result = mergePanelMessageSources(
      [
        user('conversation-1', 'same prompt', '2026-07-13T23:19:07Z'),
        user('conversation-2', 'same prompt', '2026-07-13T23:19:09Z'),
      ],
      [
        user('projected-user', 'same prompt', '2026-07-13T23:19:09Z'),
        assistant('projected-assistant', 'done', '2026-07-13T23:19:11Z'),
      ],
    );

    expect(result.map((message) => message.id)).toEqual([
      'projected-user',
      'projected-assistant',
    ]);
  });

  it('preserves repeated projected turns with identical text', () => {
    const result = mergePanelMessageSources(
      [user('conversation', 'retry', '2026-07-13T23:19:07Z')],
      [
        user('projected-1', 'retry', '2026-07-13T23:19:09Z'),
        assistant('assistant-1', 'first', '2026-07-13T23:19:11Z'),
        user('projected-2', 'retry', '2026-07-13T23:20:09Z'),
      ],
    );

    expect(result.filter((message) => message.role === 'user')).toHaveLength(2);
  });

  it('keeps the immediate conversation turn until a provider echo exists', () => {
    const result = mergePanelMessageSources(
      [user('conversation', 'starting now', '2026-07-13T23:19:07Z')],
      [],
    );

    expect(result.map((message) => message.id)).toEqual(['conversation']);
  });
});
