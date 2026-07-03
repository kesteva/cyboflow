/**
 * sanitizer tests — the renderer XSS chokepoint.
 *
 * `sanitizeHtml` wraps DOMPurify with a strict allowlist (a small set of tags +
 * only class/style attrs + three style props). `sanitizeGitOutput` HTML-escapes
 * raw git output for safe display. A regression in either re-opens an XSS hole,
 * so these pin the allowlist boundary + the escape ordering.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeHtml, sanitizeGitOutput } from '../sanitizer';

describe('sanitizeHtml — XSS allowlist', () => {
  it('strips <script> tags entirely (KEEP_CONTENT preserves inner text only)', () => {
    const out = sanitizeHtml('<script>alert(1)</script>hello');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    // KEEP_CONTENT keeps the surrounding text node.
    expect(out).toContain('hello');
  });

  it('drops an <img> with onerror (img is not in ALLOWED_TAGS)', () => {
    const out = sanitizeHtml('<img src=x onerror="alert(1)">');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert(1)');
  });

  it('neutralizes an <a href="javascript:..."> (a + href are not allowlisted)', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('href');
    expect(out.toLowerCase()).not.toContain('javascript:');
    // The anchor tag itself is not allowlisted, so only the text survives.
    expect(out).toContain('click');
  });

  it('strips disallowed attributes (onclick) while keeping allowlisted tags', () => {
    const out = sanitizeHtml('<span onclick="steal()" class="ok">x</span>');
    expect(out).toContain('<span');
    expect(out).toContain('class="ok"');
    expect(out).not.toContain('onclick');
  });

  it('preserves allowlisted tags with class/style attributes', () => {
    const out = sanitizeHtml(
      '<strong class="hl" style="color: red; font-weight: bold">bold</strong>',
    );
    expect(out).toContain('<strong');
    expect(out).toContain('class="hl"');
    expect(out).toContain('color: red');
    expect(out).toContain('font-weight: bold');
  });

  it('keeps allowlisted style props (color)', () => {
    const out = sanitizeHtml('<span style="color: red">x</span>');
    expect(out).toContain('color: red');
  });

  it('strips non-allowlisted style props (position, opacity)', () => {
    const out = sanitizeHtml('<span style="position: absolute">x</span>');
    expect(out).toContain('<span');
    expect(out).not.toContain('position');
    expect(out).not.toContain('absolute');

    const out2 = sanitizeHtml('<div style="opacity: 0.1">y</div>');
    expect(out2).not.toContain('opacity');
  });

  it('keeps only allowlisted props from a mixed style attribute', () => {
    const out = sanitizeHtml(
      '<span style="color: red; position: absolute; font-weight: bold">x</span>',
    );
    expect(out).toContain('color: red');
    expect(out).toContain('font-weight: bold');
    expect(out).not.toContain('position');
    expect(out).not.toContain('absolute');
  });

  it('leaves an element without a style attribute unaffected', () => {
    const out = sanitizeHtml('<span class="ok">x</span>');
    expect(out).toContain('<span');
    expect(out).toContain('class="ok"');
    expect(out).not.toContain('style');
  });

  it('keeps every allowlisted formatting tag', () => {
    const out = sanitizeHtml('<p><b>a</b><i>b</i><em>c</em><code>d</code><pre>e</pre><br></p>');
    for (const tag of ['<p>', '<b>', '<i>', '<em>', '<code>', '<pre>', '<br']) {
      expect(out).toContain(tag);
    }
  });
});

describe('sanitizeGitOutput — HTML entity escaping', () => {
  it('escapes all five entities (& < > " \')', () => {
    expect(sanitizeGitOutput(`a & b < c > d " e ' f`)).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &#x27; f',
    );
  });

  it('escapes & FIRST so no double-escaping occurs', () => {
    // A literal "<" must become "&lt;" — NOT "&amp;lt;" (which would happen if
    // the ampersand pass ran after the angle-bracket pass).
    const out = sanitizeGitOutput('<tag>');
    expect(out).toBe('&lt;tag&gt;');
    expect(out).not.toContain('&amp;lt;');
  });

  it('does not double-escape a pre-existing entity-looking string', () => {
    // Input "&lt;" is raw text; & escapes to &amp; then the rest is literal.
    expect(sanitizeGitOutput('&lt;')).toBe('&amp;lt;');
  });

  it('returns an empty string unchanged', () => {
    expect(sanitizeGitOutput('')).toBe('');
  });
});
