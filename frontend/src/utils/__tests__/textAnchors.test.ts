/**
 * textAnchors tests — quote-based DOM anchoring for in-artifact feedback
 * (IDEA-033). Covers capture from a live Selection, re-location as a Range
 * on a later render, highlight painting (CSS Custom Highlight API, no-op
 * under jsdom), and staleness detection.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { hashDocumentText } from '../../../../shared/types/feedback';
import {
  captureAnchor,
  findAnchorRange,
  applyHighlights,
  isAnchorStale,
  FEEDBACK_HIGHLIGHT_NAME,
} from '../textAnchors';

/** Selects the text from `startNode[startOffset]` to `endNode[endOffset]` as the live document selection. */
function selectRange(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Selection {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  if (!selection) throw new Error('window.getSelection() unavailable in this jsdom environment');
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

let container: HTMLElement | null = null;

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  container?.remove();
  container = null;
});

function mount(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  container = el;
  return el;
}

describe('captureAnchor', () => {
  it('captures a selection over a single text node', () => {
    const el = mount('<p>hello world</p>');
    const textNode = el.querySelector('p')!.firstChild!;
    const selection = selectRange(textNode, 0, textNode, 5); // "hello"

    const anchor = captureAnchor(selection, el, '# hello world');
    expect(anchor).toEqual({
      quote: 'hello',
      occurrence: 0,
      bodyHash: hashDocumentText('# hello world'),
    });
  });

  it('captures a selection spanning multiple elements (across a <strong> boundary)', () => {
    const el = mount('<p>foo <strong>bar</strong> baz</p>');
    const p = el.querySelector('p')!;
    const fooText = p.childNodes[0]; // "foo "
    const bazText = p.childNodes[2]; // " baz"
    // Select from "o " (end of "foo ") through " b" (start of " baz") -> "o bar b"
    const selection = selectRange(fooText, 2, bazText, 2);

    const anchor = captureAnchor(selection, el, 'src');
    expect(anchor?.quote).toBe('o bar b');
    expect(anchor?.occurrence).toBe(0);
  });

  it('counts occurrence among repeated quotes (0-based, counts earlier matches)', () => {
    const el = mount('<p>cat dog cat fish cat</p>');
    const textNode = el.querySelector('p')!.firstChild!;
    // "cat" occurs at indices 0, 8, 17. Select the third occurrence (index 17).
    const selection = selectRange(textNode, 17, textNode, 20);

    const anchor = captureAnchor(selection, el, 'src');
    expect(anchor?.quote).toBe('cat');
    expect(anchor?.occurrence).toBe(2);
  });

  it('returns null for a collapsed selection', () => {
    const el = mount('<p>hello world</p>');
    const textNode = el.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 0);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(captureAnchor(selection, el, 'src')).toBeNull();
  });

  it('returns null for a whitespace-only selection', () => {
    const el = mount('<p>hello   world</p>');
    const textNode = el.querySelector('p')!.firstChild!;
    const selection = selectRange(textNode, 5, textNode, 8); // the spaces between words

    expect(captureAnchor(selection, el, 'src')).toBeNull();
  });

  it('returns null when the selection is outside the container', () => {
    const el = mount('<p>hello world</p>');
    const outside = document.createElement('p');
    outside.textContent = 'outside text';
    document.body.appendChild(outside);
    const outsideText = outside.firstChild!;
    const selection = selectRange(outsideText, 0, outsideText, 7);

    expect(captureAnchor(selection, el, 'src')).toBeNull();
    outside.remove();
  });

  it('derives bodyHash from the markdown source, not the DOM text', () => {
    const el = mount('<p>hello world</p>');
    const textNode = el.querySelector('p')!.firstChild!;
    const selection = selectRange(textNode, 0, textNode, 5);

    const markdownSource = '# Totally different source markdown';
    const anchor = captureAnchor(selection, el, markdownSource);
    expect(anchor?.bodyHash).toBe(hashDocumentText(markdownSource));
    expect(anchor?.bodyHash).not.toBe(hashDocumentText(el.textContent ?? ''));
  });
});

describe('findAnchorRange', () => {
  it('locates a single-node hit', () => {
    const el = mount('<p>hello world</p>');
    const range = findAnchorRange(el, { quote: 'world', occurrence: 0, bodyHash: 'x' });
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('world');
  });

  it('locates a match spanning multiple text nodes', () => {
    const el = mount('<p>foo <strong>bar</strong> baz</p>');
    const range = findAnchorRange(el, { quote: 'o bar b', occurrence: 0, bodyHash: 'x' });
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('o bar b');
  });

  it('locates the Nth occurrence when occurrence > 0', () => {
    const el = mount('<p>cat dog cat fish cat</p>');
    const range = findAnchorRange(el, { quote: 'cat', occurrence: 2, bodyHash: 'x' });
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('cat');
    // Confirm it resolved the LAST "cat", not an earlier one.
    const prefixRange = document.createRange();
    prefixRange.setStart(el, 0);
    prefixRange.setEnd(range!.startContainer, range!.startOffset);
    expect(prefixRange.toString()).toBe('cat dog cat fish ');
  });

  it('returns null when the quote is missing entirely', () => {
    const el = mount('<p>hello world</p>');
    const range = findAnchorRange(el, { quote: 'nonexistent', occurrence: 0, bodyHash: 'x' });
    expect(range).toBeNull();
  });

  it('returns null when occurrence exceeds available matches', () => {
    const el = mount('<p>cat dog cat</p>');
    // Only 2 occurrences of "cat" (indices 0 and 1); occurrence: 2 is out of range.
    const range = findAnchorRange(el, { quote: 'cat', occurrence: 2, bodyHash: 'x' });
    expect(range).toBeNull();
  });
});

describe('applyHighlights', () => {
  it('is a no-op with a no-op cleanup when CSS.highlights is undefined (jsdom)', () => {
    const el = mount('<p>hello world</p>');
    // jsdom does not implement the CSS Custom Highlight API.
    expect((globalThis as { CSS?: { highlights?: unknown } }).CSS?.highlights).toBeUndefined();

    const cleanup = applyHighlights(el, [
      { id: 'c1', anchor: { quote: 'hello', occurrence: 0, bodyHash: 'x' } },
    ]);
    expect(typeof cleanup).toBe('function');
    expect(() => cleanup()).not.toThrow();
  });

  it('registers a Highlight under FEEDBACK_HIGHLIGHT_NAME when the API is shimmed', () => {
    const el = mount('<p>hello world</p>');

    // Minimal local shim of the CSS Custom Highlight API — jsdom doesn't
    // implement `CSS.highlights` or the global `Highlight` constructor, so we
    // stand in a faithful-enough stub to exercise applyHighlights' wiring.
    const registry = new Map<string, unknown>();
    class FakeHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    const originalCSS = globalThis.CSS;
    const originalHighlight = (globalThis as { Highlight?: unknown }).Highlight;
    (globalThis as unknown as { CSS: { highlights: Map<string, unknown> } }).CSS = {
      ...(originalCSS as object),
      highlights: registry,
    } as unknown as typeof CSS;
    (globalThis as unknown as { Highlight: unknown }).Highlight = FakeHighlight;

    try {
      const cleanup = applyHighlights(el, [
        { id: 'c1', anchor: { quote: 'hello', occurrence: 0, bodyHash: 'x' } },
        { id: 'c2', anchor: { quote: 'missing-quote', occurrence: 0, bodyHash: 'x' } },
      ]);

      expect(registry.has(FEEDBACK_HIGHLIGHT_NAME)).toBe(true);
      const registered = registry.get(FEEDBACK_HIGHLIGHT_NAME) as FakeHighlight;
      // Only the resolvable anchor ("hello") should have produced a Range;
      // the stale "missing-quote" anchor is silently skipped.
      expect(registered.ranges).toHaveLength(1);
      expect(registered.ranges[0].toString()).toBe('hello');

      cleanup();
      expect(registry.has(FEEDBACK_HIGHLIGHT_NAME)).toBe(false);
    } finally {
      (globalThis as unknown as { CSS: unknown }).CSS = originalCSS;
      if (originalHighlight === undefined) {
        delete (globalThis as { Highlight?: unknown }).Highlight;
      } else {
        (globalThis as unknown as { Highlight: unknown }).Highlight = originalHighlight;
      }
    }
  });
});

describe('isAnchorStale', () => {
  it('is false when the markdown source hash matches the anchor', () => {
    const source = '# Some spec text';
    const anchor = { quote: 'q', occurrence: 0, bodyHash: hashDocumentText(source) };
    expect(isAnchorStale(anchor, source)).toBe(false);
  });

  it('is true when the markdown source has changed since the anchor was made', () => {
    const anchor = { quote: 'q', occurrence: 0, bodyHash: hashDocumentText('# original') };
    expect(isAnchorStale(anchor, '# revised')).toBe(true);
  });
});
