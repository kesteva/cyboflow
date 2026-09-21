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
import { render, screen } from '@testing-library/react';
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

// ---------------------------------------------------------------------------
// TASK-269 — hidden/empty-only messages must render NO row (not the raw-JSON
// "Unhandled message type" fallback, which leaks exactly the content the
// user hid via settings.showThinking / settings.showToolCalls).
// ---------------------------------------------------------------------------

/** Asserts that `messageId` produced no visible row: no MessageSegment call,
 * no "Unhandled message type" fallback card anywhere in the document. */
function expectNoRow(messageId: string): void {
  expect(screen.queryByTestId(`seg-${messageId}`)).toBeNull();
  expect(screen.queryByText('Unhandled message type')).toBeNull();
  expect(segmentRenders.ids).not.toContain(messageId);
}

describe('ChatTranscript — visibility gating (TASK-269)', () => {
  it('a thinking-only message hidden by showThinking:false renders no row', () => {
    const hidden: UnifiedMessage = {
      id: 'think-hidden',
      role: 'assistant',
      timestamp: '2026-07-17T00:00:00Z',
      segments: [{ type: 'thinking', content: 'secret reasoning the user opted out of' }],
    };
    render(
      <ChatTranscript
        {...makeProps({ messages: [hidden], settings: { ...settings, showThinking: false } })}
      />,
    );
    expectNoRow('think-hidden');
  });

  it('a thinking-only message with whitespace-only content renders no row even when showThinking:true', () => {
    const blank: UnifiedMessage = {
      id: 'think-blank',
      role: 'assistant',
      timestamp: '2026-07-17T00:00:00Z',
      segments: [{ type: 'thinking', content: '   \n\t  ' }],
    };
    render(
      <ChatTranscript
        {...makeProps({ messages: [blank], settings: { ...settings, showThinking: true } })}
      />,
    );
    expectNoRow('think-blank');
  });

  it('a tool_call-only message hidden by showToolCalls:false renders no row', () => {
    const toolOnly: UnifiedMessage = {
      id: 'tool-hidden',
      role: 'assistant',
      timestamp: '2026-07-17T00:00:00Z',
      segments: [{ type: 'tool_call', tool: { id: 'tool-x', name: 'Read', status: 'success' } }],
    };
    render(
      <ChatTranscript
        {...makeProps({ messages: [toolOnly], settings: { ...settings, showToolCalls: false } })}
      />,
    );
    expectNoRow('tool-hidden');
  });

  it('a tool_result-only message hidden by showToolCalls:false renders no row', () => {
    const resultOnly: UnifiedMessage = {
      id: 'result-hidden',
      role: 'assistant',
      timestamp: '2026-07-17T00:00:00Z',
      segments: [{ type: 'tool_result', result: { content: 'file contents', toolCallId: 'tool-x' } }],
    };
    render(
      <ChatTranscript
        {...makeProps({ messages: [resultOnly], settings: { ...settings, showToolCalls: false } })}
      />,
    );
    expectNoRow('result-hidden');
  });

  it('a message with a genuinely unrecognized segment type still hits the Unhandled-type fallback', () => {
    // `error` is a real MessageSegment variant, but ChatTranscript's
    // hasRenderableContent never counted it — this is the PRE-EXISTING raw-JSON
    // fallback path (untouched by TASK-269), asserted here so the new
    // visibility-gating branch can't accidentally swallow it.
    const unknown: UnifiedMessage = {
      id: 'unknown-type',
      role: 'assistant',
      timestamp: '2026-07-17T00:00:00Z',
      segments: [{ type: 'error', error: { message: 'boom' } }],
    };
    render(<ChatTranscript {...makeProps({ messages: [unknown], settings })} />);
    expect(screen.getByText('Unhandled message type')).toBeInTheDocument();
  });

  it('a message with non-empty text plus hidden thinking/tool segments renders exactly as before', () => {
    const mixed: UnifiedMessage = {
      id: 'text-plus-hidden',
      role: 'assistant',
      timestamp: '2026-07-17T00:00:00Z',
      segments: [
        { type: 'thinking', content: 'hidden reasoning' },
        { type: 'text', content: 'the visible reply' },
        { type: 'tool_call', tool: { id: 'tool-y', name: 'Read', status: 'success' } },
      ],
    };
    render(
      <ChatTranscript
        {...makeProps({
          messages: [mixed],
          settings: { ...settings, showThinking: false, showToolCalls: false },
        })}
      />,
    );
    expect(screen.getByTestId('seg-text-plus-hidden')).toBeInTheDocument();
    expect(screen.queryByText('Unhandled message type')).toBeNull();
  });

  it('a diff-only message renders ungated regardless of showThinking/showToolCalls', () => {
    const diffOnly: UnifiedMessage = {
      id: 'diff-only',
      role: 'assistant',
      timestamp: '2026-07-17T00:00:00Z',
      segments: [{ type: 'diff', diff: '--- a\n+++ b\n' }],
    };
    render(
      <ChatTranscript
        {...makeProps({
          messages: [diffOnly],
          settings: { ...settings, showThinking: false, showToolCalls: false },
        })}
      />,
    );
    expect(screen.getByTestId('seg-diff-only')).toBeInTheDocument();
    expect(screen.queryByText('Unhandled message type')).toBeNull();
  });
});
