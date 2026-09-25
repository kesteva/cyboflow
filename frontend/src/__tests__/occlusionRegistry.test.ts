// @vitest-environment node

/**
 * Occlusion registry — the convention that keeps overlays above the web viewer.
 *
 * A web tab's page is a main-process `WebContentsView` composited ABOVE all
 * renderer DOM. An overlay that does not take an occlusion lease
 * (`useOcclusion`, frontend/src/hooks/useOcclusion.ts) renders BEHIND the page
 * or is unclickable where the page covers it — and the symptom looks like a CSS
 * bug, not a viewer bug, so nobody connects it back here.
 *
 * A one-time inventory of overlays was not enough (the first pass of the
 * proposal missed two), so this test scans every renderer `.tsx` for the shapes
 * that paint over the center pane — a `fixed`/`absolute` element at z-40 or
 * above (numeric, arbitrary or semantic tier), or a `createPortal` — and fails
 * unless the file calls `useOcclusion(` or carries a reasoned exemption below.
 *
 * Adding an overlay? Call `useOcclusion(open)` with its open flag. Only add an
 * exemption when the overlay provably cannot reach the center pane or another
 * lease already covers it — and say which.
 *
 * See docs/proposals/native-web-viewer.md §3.7.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..');

/**
 * Files that match an overlay shape but need no lease of their own. Keyed by
 * path relative to frontend/src, posix separators.
 */
const EXEMPT: Record<string, string> = {
  'components/ui/Tooltip.tsx':
    'hover-only: a lease would blank the page on every hover; a tooltip clipped by the page is cosmetic',
  'components/SessionListItem.tsx':
    'its context menu is opened through ContextMenuContext, whose provider holds the lease',
  'components/FilePathAutocomplete.tsx':
    'absolute (not portaled) and trigger-width inside the composer column, so it cannot reach the center pane',
};

const POSITIONED = /\b(fixed|absolute)\b/;
const HIGH_Z =
  /\bz-(40|50|\[(?:[4-9]\d|\d{3,})\]|modal|modal-backdrop|popover|dropdown|dropdown-backdrop|fixed|tooltip)(?![\w-])/;
const PORTAL = /\bcreatePortal\(/;

/** Does this source contain an overlay shape? Returns the first offending line. */
function findOverlayLine(source: string): string | null {
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (PORTAL.test(line)) return trimmed;
    if (POSITIONED.test(line) && HIGH_Z.test(line)) return trimmed;
  }
  return null;
}

function registers(source: string): boolean {
  return /\buseOcclusion\(/.test(source);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'test') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.tsx') && !/\.(test|spec|stories)\.tsx$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC).map((full) => ({
  path: relative(SRC, full).split(sep).join('/'),
  source: readFileSync(full, 'utf8'),
}));

describe('occlusion registry', () => {
  it('scans a real tree (guards against the walker silently finding nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.path === 'components/ui/Modal.tsx')).toBe(true);
  });

  it('every overlay that can paint over the center pane takes an occlusion lease', () => {
    const offenders = files
      .filter((f) => !(f.path in EXEMPT))
      .map((f) => ({ ...f, line: findOverlayLine(f.source) }))
      .filter((f) => f.line !== null && !registers(f.source))
      .map((f) => `${f.path}: ${f.line}`);
    expect(
      offenders,
      'These overlays would render BEHIND a web tab. Call useOcclusion(open) ' +
        '(hooks/useOcclusion.ts) or add a reasoned EXEMPT entry.',
    ).toEqual([]);
  });

  it('carries no stale exemptions', () => {
    const byPath = new Map(files.map((f) => [f.path, f.source]));
    const stale = Object.keys(EXEMPT).filter((path) => {
      const source = byPath.get(path);
      return source === undefined || findOverlayLine(source) === null || registers(source);
    });
    expect(stale, 'Remove exemptions for files that no longer need them').toEqual([]);
  });

  describe('detector', () => {
    it.each([
      '<div className="fixed inset-0 z-50">',
      "'absolute bottom-full right-0 mb-2 z-50',",
      '<div className="absolute z-[60] top-0">',
      '<div className="pointer-events-none fixed inset-0 z-popover">',
      'return createPortal(<Menu />, document.body);',
    ])('flags %s', (line) => {
      expect(findOverlayLine(line)).not.toBeNull();
    });

    it.each([
      '<div className="relative z-50">',
      '<div className="absolute z-10">',
      '<div className="fixed bottom-0 z-30">',
      '<div className="absolute z-[35]">',
      '// a fixed z-50 toast used to live here',
      '<div className="fixed z-500-ish">',
    ])('ignores %s', (line) => {
      expect(findOverlayLine(line)).toBeNull();
    });
  });
});
