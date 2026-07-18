/**
 * MessageSegment tests — the segment is wrapped in React.memo so that when a
 * transcript row re-renders for an unrelated reason but a given segment's props
 * are unchanged, the segment (and its memoized MarkdownPreview) is skipped
 * rather than re-parsing its markdown.
 */
import '@testing-library/jest-dom';
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useMemo, useState } from 'react';
import type { MessageSegment as MessageSegmentType } from '../../transformers/MessageTransformer';

const parseCounter = vi.hoisted(() => ({ count: 0 }));

// MarkdownPreview is the parse-cost proxy — count how often it renders.
vi.mock('../../../../MarkdownPreview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => {
    parseCounter.count += 1;
    return <div data-testid="markdown">{content}</div>;
  },
}));

import { MessageSegment } from '../MessageSegment';

const noop = (): void => {};

// Harness that can force parent re-renders while keeping the segment's props
// referentially stable.
function Harness({ segment }: { segment: MessageSegmentType }) {
  const [, force] = useState(0);
  const expandedTools = useMemo(() => new Set<string>(), []);
  return (
    <>
      <button data-testid="force" onClick={() => force((n) => n + 1)}>
        force
      </button>
      <MessageSegment
        segment={segment}
        messageId="m1"
        index={0}
        isUser={false}
        expandedTools={expandedTools}
        collapseTools
        showToolCalls
        showThinking
        onToggleToolExpand={noop}
      />
    </>
  );
}

beforeEach(() => {
  parseCounter.count = 0;
});

describe('MessageSegment', () => {
  it('renders assistant text through MarkdownPreview', () => {
    const segment: MessageSegmentType = { type: 'text', content: 'hi there' };
    const { getByTestId } = render(<Harness segment={segment} />);
    expect(getByTestId('markdown')).toHaveTextContent('hi there');
    expect(parseCounter.count).toBe(1);
  });

  it('is memoized: a parent re-render with unchanged props does not re-parse', () => {
    const segment: MessageSegmentType = { type: 'text', content: 'hi there' };
    const { getByTestId } = render(<Harness segment={segment} />);
    expect(parseCounter.count).toBe(1);

    fireEvent.click(getByTestId('force'));
    fireEvent.click(getByTestId('force'));

    // Props to MessageSegment are referentially stable → memo skips → no re-parse.
    expect(parseCounter.count).toBe(1);
  });
});
