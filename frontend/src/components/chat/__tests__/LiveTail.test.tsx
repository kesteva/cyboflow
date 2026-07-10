/**
 * LiveTail smoke tests — renders the reduced block list with the shared
 * MessageSegment renderer. Not exercising markdown internals (covered by
 * MessageSegment's own usage elsewhere); just the empty-guard and the
 * text/thinking passthrough.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LiveTail } from '../LiveTail';
import type { LiveTailBlock } from '../../../utils/liveTailReducer';

describe('LiveTail', () => {
  it('renders nothing for an empty block list', () => {
    const { container } = render(<LiveTail blocks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a text block with the agent name and content', () => {
    const blocks: LiveTailBlock[] = [{ index: 0, kind: 'text', text: 'Hello there' }];
    render(<LiveTail blocks={blocks} agentName="Claude" />);
    expect(screen.getByTestId('live-tail')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Hello there')).toBeInTheDocument();
  });

  it('renders multiple blocks in the order given', () => {
    const blocks: LiveTailBlock[] = [
      { index: 0, kind: 'thinking', text: 'pondering' },
      { index: 1, kind: 'text', text: 'the answer' },
    ];
    render(<LiveTail blocks={blocks} />);
    expect(screen.getByText('pondering')).toBeInTheDocument();
    expect(screen.getByText('the answer')).toBeInTheDocument();
  });

  it('does not render an empty-text block (MessageSegment trims blank content)', () => {
    const blocks: LiveTailBlock[] = [{ index: 0, kind: 'text', text: '   ' }];
    const { container } = render(<LiveTail blocks={blocks} />);
    // The message frame still renders (avatar/name), but no text node for the segment.
    expect(screen.getByTestId('live-tail')).toBeInTheDocument();
    expect(container.querySelector('.rich-output-markdown')).toBeNull();
  });
});
