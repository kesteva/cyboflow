/**
 * ChatTranscript tests — the transcript is restructured into a memoized
 * grouping prepass + memoized per-row components fed only their own scalar
 * state, so a copy click or a single tool toggle re-renders ONLY the affected
 * row rather than the whole transcript.
 *
 * The leaf children are mocked; MessageSegment is a render probe that records
 * the message id each time it renders, so "only row X re-rendered" is asserted
 * by "only X's segment was re-invoked".
 */
import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RefObject, MutableRefObject } from 'react';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';
import type { RichOutputSettings } from '../../panels/ai/AbstractAIPanel';

const segmentRenders = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock('../../panels/ai/components/MessageSegment', () => ({
  MessageSegment: ({ messageId }: { messageId: string }) => {
    segmentRenders.ids.push(messageId);
    return <div data-testid={`seg-${messageId}`} />;
  },
}));
vi.mock('../../panels/ai/components/ToolCallGroup', () => ({
  ToolCallGroup: () => <div data-testid="tool-group" />,
}));
vi.mock('../../panels/ai/components/ToolCallView', () => ({
  ToolCallView: () => <div data-testid="tool-view" />,
}));
vi.mock('../../panels/ai/components/TodoListDisplay', () => ({
  TodoListDisplay: () => <div data-testid="todo" />,
}));

import { ChatTranscript, type ChatTranscriptProps } from '../ChatTranscript';

// ---------------------------------------------------------------------------
// Stable references shared across render + rerender so only the one prop under
// test differs (that is the whole point — memo must key on it, not on identity
// churn elsewhere).
// ---------------------------------------------------------------------------

function assistantWithTool(id: string, text: string, toolId: string): UnifiedMessage {
  return {
    id,
    role: 'assistant',
    timestamp: '2026-07-17T00:00:00Z',
    segments: [
      { type: 'text', content: text },
      { type: 'tool_call', tool: { id: toolId, name: 'Read', status: 'success' } },
    ],
  };
}

const messages: UnifiedMessage[] = [
  assistantWithTool('a1', 'alpha', 't1'),
  assistantWithTool('a2', 'beta', 't2'),
];

const settings: RichOutputSettings = {
  showToolCalls: true,
  compactMode: false,
  collapseTools: true,
  showThinking: true,
  showSessionInit: false,
};

const collapsedMessages = new Set<string>();
const onToggleMessageCollapse = vi.fn();
const onToggleToolExpand = vi.fn();
const onCopyMessage = vi.fn();
const onScrollToBottom = vi.fn();
const scrollContainerRef: RefObject<HTMLDivElement | null> = { current: null };
const messagesEndRef: RefObject<HTMLDivElement | null> = { current: null };
const userMessageRefs: MutableRefObject<Map<number, HTMLDivElement>> = { current: new Map() };

function makeProps(overrides: Partial<ChatTranscriptProps>): ChatTranscriptProps {
  return {
    messages,
    settings,
    agentName: 'Claude',
    collapsedMessages,
    onToggleMessageCollapse,
    expandedTools: new Set<string>(),
    onToggleToolExpand,
    copiedMessageId: null,
    onCopyMessage,
    scrollContainerRef,
    messagesEndRef,
    userMessageRefs,
    showScrollButton: false,
    onScrollToBottom,
    ...overrides,
  };
}

beforeEach(() => {
  segmentRenders.ids = [];
});

describe('ChatTranscript — per-row memoization', () => {
  it('renders one segment per message on first paint', () => {
    render(<ChatTranscript {...makeProps({})} />);
    expect(segmentRenders.ids.sort()).toEqual(['a1', 'a2']);
  });

  it('(g) a copy set touches only the affected row', () => {
    const emptyExpanded = new Set<string>();
    const { rerender } = render(
      <ChatTranscript {...makeProps({ expandedTools: emptyExpanded, copiedMessageId: null })} />,
    );
    segmentRenders.ids = [];

    // Copy on a1 — only a1's row should re-render (isCopied flips for a1 only).
    rerender(
      <ChatTranscript {...makeProps({ expandedTools: emptyExpanded, copiedMessageId: 'a1' })} />,
    );

    expect(segmentRenders.ids).toContain('a1');
    expect(segmentRenders.ids).not.toContain('a2');
  });

  it('(g) resetting the copied id also touches only that row', () => {
    const emptyExpanded = new Set<string>();
    const { rerender } = render(
      <ChatTranscript {...makeProps({ expandedTools: emptyExpanded, copiedMessageId: 'a1' })} />,
    );
    segmentRenders.ids = [];

    rerender(
      <ChatTranscript {...makeProps({ expandedTools: emptyExpanded, copiedMessageId: null })} />,
    );

    expect(segmentRenders.ids).toContain('a1');
    expect(segmentRenders.ids).not.toContain('a2');
  });

  it('(h) expanding a single tool leaves sibling rows untouched', () => {
    const { rerender } = render(
      <ChatTranscript {...makeProps({ expandedTools: new Set<string>(), copiedMessageId: null })} />,
    );
    segmentRenders.ids = [];

    // Expand t1 (belongs to a1). Only a1's expanded signature changes.
    rerender(
      <ChatTranscript {...makeProps({ expandedTools: new Set<string>(['t1']), copiedMessageId: null })} />,
    );

    expect(segmentRenders.ids).toContain('a1');
    expect(segmentRenders.ids).not.toContain('a2');
  });
});
