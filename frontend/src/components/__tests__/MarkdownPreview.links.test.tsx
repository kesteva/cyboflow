/**
 * MarkdownPreview links → the web viewer (docs/proposals/native-web-viewer.md §4).
 *
 * This is the renderer's ONLY ReactMarkdown call site, so the `a` override
 * reaches every markdown surface in the app. Pinned: inside a chat
 * (WebLinkContext) a plain click on an absolute http(s) link opens a web tab;
 * outside one, and for every bypass (modifier-click, middle-click, a non-web or
 * relative href), the link keeps its original target=_blank escape.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../MermaidRenderer', () => ({ MermaidRenderer: () => null }));

import { MarkdownPreview } from '../MarkdownPreview';
import { WebLinkContext } from '../../contexts/WebLinkContext';

function renderInChat(content: string) {
  const open = vi.fn();
  render(
    <WebLinkContext.Provider value={open}>
      <MarkdownPreview content={content} />
    </WebLinkContext.Provider>,
  );
  return open;
}

/** Fire a click and report whether the default (the _blank escape) was kept. */
function click(el: HTMLElement, init: MouseEventInit = {}): boolean {
  return fireEvent.click(el, { button: 0, ...init });
}

describe('MarkdownPreview links', () => {
  it('keeps target=_blank + noopener on every link', () => {
    render(<MarkdownPreview content="[docs](https://example.com/docs)" />);
    const a = screen.getByRole('link', { name: 'docs' });
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('outside a chat, a click keeps the original escape (no provider → today’s behaviour)', () => {
    render(<MarkdownPreview content="[docs](https://example.com/docs)" />);
    expect(click(screen.getByRole('link', { name: 'docs' }))).toBe(true);
  });

  it('inside a chat, a plain click opens a web tab and suppresses the escape', () => {
    const open = renderInChat('[docs](https://example.com/docs?q=1)');
    expect(click(screen.getByRole('link', { name: 'docs' }))).toBe(false);
    expect(open).toHaveBeenCalledWith('https://example.com/docs?q=1');
  });

  it.each([
    ['cmd-click', { metaKey: true }],
    ['ctrl-click', { ctrlKey: true }],
    ['shift-click', { shiftKey: true }],
    ['middle-click', { button: 1 }],
  ])('%s bypasses to the OS browser', (_name, init) => {
    const open = renderInChat('[docs](https://example.com/docs)');
    expect(click(screen.getByRole('link', { name: 'docs' }), init)).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['a mailto link', '[mail](mailto:a@example.com)', 'mail'],
    ['a relative link', '[rel](/settings)', 'rel'],
  ])('%s is never routed to the viewer', (_name, content, name) => {
    const open = renderInChat(content);
    click(screen.getByRole('link', { name }));
    expect(open).not.toHaveBeenCalled();
  });
});
