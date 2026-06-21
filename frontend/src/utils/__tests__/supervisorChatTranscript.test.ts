import { describe, it, expect } from 'vitest';
import { mergeChatMessage, seedTranscript, type ChatMessage } from '../supervisorChatTranscript';

const m = (role: ChatMessage['role'], text: string, ts: string): ChatMessage => ({ role, text, ts });

describe('mergeChatMessage', () => {
  it('appends a new message with a distinct (role, ts)', () => {
    const t = [m('user', 'hi', '1')];
    expect(mergeChatMessage(t, m('assistant', 'hello', '2'))).toEqual([
      m('user', 'hi', '1'),
      m('assistant', 'hello', '2'),
    ]);
  });

  it('replaces a growing assistant message in place (same role+ts)', () => {
    let t: ChatMessage[] = [m('user', 'q', '1')];
    t = mergeChatMessage(t, m('assistant', 'Hel', '2'));
    t = mergeChatMessage(t, m('assistant', 'Hello', '2')); // grew
    expect(t).toEqual([m('user', 'q', '1'), m('assistant', 'Hello', '2')]);
  });

  it('is idempotent on a seed/subscription overlap (same role+ts)', () => {
    const t = [m('assistant', 'done', '2')];
    expect(mergeChatMessage(t, m('assistant', 'done', '2'))).toEqual([m('assistant', 'done', '2')]);
  });

  it('appends distinct assistant turns (different ts) instead of merging', () => {
    let t: ChatMessage[] = [];
    t = mergeChatMessage(t, m('assistant', 'first', '1'));
    t = mergeChatMessage(t, m('user', 'more', '2'));
    t = mergeChatMessage(t, m('assistant', 'second', '3'));
    expect(t.map((x) => x.text)).toEqual(['first', 'more', 'second']);
  });

  it('does not mutate the input array', () => {
    const t = [m('user', 'a', '1')];
    const out = mergeChatMessage(t, m('assistant', 'b', '2'));
    expect(t).toEqual([m('user', 'a', '1')]);
    expect(out).not.toBe(t);
  });
});

describe('seedTranscript', () => {
  it('copies the messages into a fresh array', () => {
    const src = [m('system', 'x', '1')];
    const out = seedTranscript(src);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
  });
});
