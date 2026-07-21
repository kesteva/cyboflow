/**
 * Quote-based DOM anchors for in-artifact feedback (IDEA-033).
 *
 * Comments attach to a span of RENDERED text inside a markdown preview
 * container (see `shared/types/feedback.ts` for the `CommentAnchor` contract
 * and the rationale for quote+occurrence anchoring over offsets). This module
 * is pure DOM plumbing: capture an anchor from a live `Selection`, re-locate
 * it as a `Range` on a later render, and paint saved anchors with the CSS
 * Custom Highlight API. No React here — that lives in a separate UI task.
 */
import { type CommentAnchor, hashDocumentText } from '../../../shared/types/feedback';

/** Registered `Highlight` name; the `::highlight(cyboflow-feedback)` CSS rule lives with the UI task. */
export const FEEDBACK_HIGHLIGHT_NAME = 'cyboflow-feedback';

/** Feature-detected slice of the CSS Custom Highlight API we depend on (avoids `any`). */
interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}
interface HighlightConstructor {
  new (...ranges: Range[]): unknown;
}
interface CssWithHighlights {
  highlights: HighlightRegistry;
}

function getHighlightSupport(): { highlights: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const cssWithHighlights = globalThis.CSS as unknown as Partial<CssWithHighlights> | undefined;
  const HighlightCtor = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  if (!cssWithHighlights?.highlights || !HighlightCtor) return null;
  return { highlights: cssWithHighlights.highlights, Highlight: HighlightCtor };
}

/**
 * Counts occurrences of `quote` in `text` (non-overlapping scan, left to right).
 */
function countOccurrences(text: string, quote: string): number {
  if (quote.length === 0) return 0;
  let count = 0;
  let fromIndex = 0;
  for (;;) {
    const idx = text.indexOf(quote, fromIndex);
    if (idx === -1) break;
    count++;
    fromIndex = idx + quote.length;
  }
  return count;
}

/**
 * Captures a `CommentAnchor` from a live selection inside `container`.
 *
 * Returns null when the selection is collapsed/empty, resolves to
 * whitespace-only text, or spans outside `container`.
 */
export function captureAnchor(
  selection: Selection,
  container: HTMLElement,
  markdownSource: string,
): CommentAnchor | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;

  const rawQuote = selection.toString();
  const quote = rawQuote.trim();
  if (quote.length === 0) return null;

  const range = selection.getRangeAt(0);
  if (
    !container.contains(range.startContainer) ||
    !container.contains(range.endContainer)
  ) {
    return null;
  }

  // Prefix = container text from its start up to the selection's start —
  // used to count how many earlier occurrences of `quote` precede it.
  const prefixRange = document.createRange();
  prefixRange.setStart(container, 0);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const prefixText = prefixRange.toString();
  const occurrence = countOccurrences(prefixText, quote);

  return {
    quote,
    occurrence,
    bodyHash: hashDocumentText(markdownSource),
  };
}

interface TextNodeIndexEntry {
  node: Text;
  /** Offset of this node's first character within the concatenated text. */
  start: number;
}

/**
 * Walks all text nodes under `container` in document order, building the
 * concatenated rendered text plus an index for mapping a global offset back
 * to a (node, localOffset) pair.
 */
function buildTextIndex(container: HTMLElement): { text: string; entries: TextNodeIndexEntry[] } {
  const entries: TextNodeIndexEntry[] = [];
  let text = '';
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    entries.push({ node: textNode, start: text.length });
    text += textNode.data;
    node = walker.nextNode();
  }
  return { text, entries };
}

/** Maps a global offset into `entries` (from `buildTextIndex`) to a (node, localOffset) pair. */
function resolveOffset(
  entries: TextNodeIndexEntry[],
  globalOffset: number,
): { node: Text; offset: number } | null {
  // Find the last entry whose start is <= globalOffset.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.start <= globalOffset) {
      const localOffset = globalOffset - entry.start;
      if (localOffset <= entry.node.data.length) {
        return { node: entry.node, offset: localOffset };
      }
      return null;
    }
  }
  return null;
}

/**
 * Re-locates a saved anchor as a live `Range` inside `container`.
 *
 * Matching is EXACT string matching against the container's current
 * concatenated text content — the quote was captured from the same rendered
 * DOM, so no fuzzy/normalized matching is attempted. If the document has
 * since changed such that the Nth occurrence of `quote` no longer exists,
 * this returns null (a stale anchor); callers should treat that as
 * "couldn't relocate" rather than an error.
 */
export function findAnchorRange(container: HTMLElement, anchor: CommentAnchor): Range | null {
  if (anchor.quote.length === 0) return null;

  const { text, entries } = buildTextIndex(container);
  if (entries.length === 0) return null;

  let searchFrom = 0;
  let matchStart = -1;
  for (let occurrenceIndex = 0; occurrenceIndex <= anchor.occurrence; occurrenceIndex++) {
    matchStart = text.indexOf(anchor.quote, searchFrom);
    if (matchStart === -1) return null;
    searchFrom = matchStart + anchor.quote.length;
  }

  const matchEnd = matchStart + anchor.quote.length;
  const start = resolveOffset(entries, matchStart);
  // matchEnd is exclusive; resolve against the last included character so an
  // exact-end match still lands inside (not past) its owning text node.
  const end = resolveOffset(entries, matchEnd - 1);
  if (!start || !end) return null;

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

/**
 * Paints highlights for every resolvable entry using the CSS Custom
 * Highlight API (`CSS.highlights` — supported in Electron's Chromium).
 * Entries whose anchor can't be relocated (stale) are silently skipped.
 *
 * No-ops (returning a no-op cleanup) when the Highlight API is unavailable,
 * e.g. under jsdom in tests. Re-entrant: calling again simply replaces the
 * registered highlight under `FEEDBACK_HIGHLIGHT_NAME`.
 *
 * The visual style (`::highlight(cyboflow-feedback) { ... }`) is added by
 * the UI task, not here.
 */
export function applyHighlights(
  container: HTMLElement,
  entries: Array<{ id: string; anchor: CommentAnchor }>,
): () => void {
  const support = getHighlightSupport();
  if (!support) return () => {};

  const ranges: Range[] = [];
  for (const entry of entries) {
    const range = findAnchorRange(container, entry.anchor);
    if (range) ranges.push(range);
  }

  const highlight = new support.Highlight(...ranges);
  support.highlights.set(FEEDBACK_HIGHLIGHT_NAME, highlight);

  return () => {
    support.highlights.delete(FEEDBACK_HIGHLIGHT_NAME);
  };
}

/** True when `markdownSource`'s current hash no longer matches the anchor's recorded `bodyHash`. */
export function isAnchorStale(anchor: CommentAnchor, markdownSource: string): boolean {
  return hashDocumentText(markdownSource) !== anchor.bodyHash;
}
