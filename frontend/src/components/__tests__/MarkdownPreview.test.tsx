/**
 * MarkdownPreview tests — the markdown layer is memoized so an unchanged
 * `content` string never re-invokes ReactMarkdown (the transcript used to
 * re-parse ALL markdown on every live refetch). ReactMarkdown + MermaidRenderer
 * are mocked so the assertion is purely "did the parse run again".
 */
import '@testing-library/jest-dom';
import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const parseCounter = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => {
    parseCounter.count += 1;
    return <div data-testid="react-markdown">{children}</div>;
  },
}));

// MermaidRenderer pulls in the heavy `mermaid` dependency — stub it out.
vi.mock('../MermaidRenderer', () => ({
  MermaidRenderer: () => <div data-testid="mermaid" />,
}));

import { MarkdownPreview } from '../MarkdownPreview';

beforeEach(() => {
  parseCounter.count = 0;
});

describe('MarkdownPreview', () => {
  it('parses once on first render', () => {
    render(<MarkdownPreview content="hello" />);
    expect(parseCounter.count).toBe(1);
  });

  it('(i) does not re-invoke ReactMarkdown when re-rendered with identical content', () => {
    const { rerender } = render(<MarkdownPreview content="hello" id="a" />);
    expect(parseCounter.count).toBe(1);

    // Identical props → React.memo blocks the re-render entirely.
    rerender(<MarkdownPreview content="hello" id="a" />);
    expect(parseCounter.count).toBe(1);
  });

  it('(i) re-renders on an unrelated prop change but the useMemo avoids re-parsing', () => {
    const { rerender } = render(<MarkdownPreview content="hello" id="a" />);
    expect(parseCounter.count).toBe(1);

    // `id` changes → the component re-renders (memo lets it through), but the
    // content-keyed useMemo returns the cached subtree, so no re-parse.
    rerender(<MarkdownPreview content="hello" id="b" />);
    expect(parseCounter.count).toBe(1);
  });

  it('re-parses only when the content string actually changes', () => {
    const { rerender } = render(<MarkdownPreview content="hello" id="b" />);
    expect(parseCounter.count).toBe(1);

    rerender(<MarkdownPreview content="goodbye" id="b" />);
    expect(parseCounter.count).toBe(2);
  });
});
