/**
 * Unit tests for markdownFrontmatter.ts
 *
 * Behaviors covered (per TASK-652 test_strategy):
 * 1. Standard LF frontmatter — returns correct frontmatter map and body
 * 2. CRLF frontmatter — returns same shape as LF case
 * 3. Single-quoted value strip — surrounding single quotes removed
 * 4. Double-quoted value strip — surrounding double quotes removed
 * 5. `---` inside body — preserved; regex anchored to start-of-file
 * 6. Missing frontmatter — full content as body, empty frontmatter record
 *
 * No temp-file fixtures needed — the helper takes a string, not a path.
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdownFrontmatter } from '../markdownFrontmatter';

describe('parseMarkdownFrontmatter', () => {
  // -------------------------------------------------------------------------
  // Case 1: Standard LF frontmatter
  // -------------------------------------------------------------------------
  it('returns frontmatter map and body for standard LF input', () => {
    const md = '---\nkey: value\n---\nbody.';
    const { frontmatter, body } = parseMarkdownFrontmatter(md);
    expect(frontmatter).toEqual({ key: 'value' });
    expect(body).toBe('body.');
  });

  // -------------------------------------------------------------------------
  // Case 2: CRLF frontmatter
  // -------------------------------------------------------------------------
  it('returns same shape as LF case for CRLF line endings', () => {
    const md = '---\r\nkey: value\r\n---\r\nbody.';
    const { frontmatter, body } = parseMarkdownFrontmatter(md);
    expect(frontmatter).toEqual({ key: 'value' });
    expect(body).toBe('body.');
  });

  // -------------------------------------------------------------------------
  // Case 3: Single-quoted value strip
  // -------------------------------------------------------------------------
  it('strips surrounding single quotes from frontmatter values', () => {
    const md = "---\ntitle: 'My Title'\n---\nbody.";
    const { frontmatter } = parseMarkdownFrontmatter(md);
    expect(frontmatter['title']).toBe('My Title');
  });

  // -------------------------------------------------------------------------
  // Case 4: Double-quoted value strip
  // -------------------------------------------------------------------------
  it('strips surrounding double quotes from frontmatter values', () => {
    const md = '---\ntitle: "My Title"\n---\nbody.';
    const { frontmatter } = parseMarkdownFrontmatter(md);
    expect(frontmatter['title']).toBe('My Title');
  });

  // -------------------------------------------------------------------------
  // Case 5: `---` inside body not treated as second delimiter
  // -------------------------------------------------------------------------
  it('preserves --- inside the body; regex is anchored to start-of-file', () => {
    const md = '---\ntitle: Test\n---\nFirst paragraph.\n\n---\n\nSecond section.';
    const { frontmatter, body } = parseMarkdownFrontmatter(md);
    expect(frontmatter).toEqual({ title: 'Test' });
    expect(body).toBe('First paragraph.\n\n---\n\nSecond section.');
  });

  // -------------------------------------------------------------------------
  // Case 6: Missing frontmatter — full content as body, empty record
  // -------------------------------------------------------------------------
  it('returns full content as body and empty frontmatter when no delimiter is found', () => {
    const md = 'Just a plain body with no frontmatter.';
    const { frontmatter, body } = parseMarkdownFrontmatter(md);
    expect(frontmatter).toEqual({});
    expect(body).toBe('Just a plain body with no frontmatter.');
  });

  // -------------------------------------------------------------------------
  // Case 7 (bonus): Multi-key frontmatter — all keys extracted, insertion order
  // -------------------------------------------------------------------------
  it('extracts multiple keys into the frontmatter record preserving insertion order', () => {
    const md = '---\nalpha: one\nbeta: two\ngamma: three\n---\nbody text.';
    const { frontmatter, body } = parseMarkdownFrontmatter(md);
    expect(Object.keys(frontmatter)).toEqual(['alpha', 'beta', 'gamma']);
    expect(frontmatter['alpha']).toBe('one');
    expect(frontmatter['beta']).toBe('two');
    expect(frontmatter['gamma']).toBe('three');
    expect(body).toBe('body text.');
  });
});
