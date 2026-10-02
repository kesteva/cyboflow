// @vitest-environment node
//
// Node env, not the suite default jsdom: this file imports the real
// vite.config, which pulls in vite + @vitejs/plugin-react + esbuild, and
// esbuild refuses to load under jsdom's TextEncoder.

/**
 * Build-time Content-Security-Policy injection (frontend/vite.config.ts →
 * `cyboflow-csp` plugin).
 *
 * The packaged renderer loads over `file://`, so a `<meta http-equiv>` baked
 * into the BUILT index.html is the only way to attach a policy. These tests run
 * the plugin's `transformIndexHtml` over the real `frontend/index.html` and
 * assert the resulting policy, because the two properties that matter are easy
 * to lose silently:
 *
 *   - `script-src` must carry HASHES of the inline theme scripts, not
 *     `'unsafe-inline'` — the whole point is that injected markup cannot run;
 *   - the plugin must be `apply: 'build'`, so the dev server (HMR client,
 *     react-refresh preamble — both inline scripts no static hash can cover)
 *     is untouched.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Shape of the bits of a Vite plugin this test drives. Kept local so the test
// does not depend on vite's type exports resolving under the app tsconfig.
interface HtmlPlugin {
  name: string;
  apply?: string;
  enforce?: string;
  transformIndexHtml?: (html: string) => string;
}

const INDEX_HTML = join(__dirname, '../../index.html');

let plugin: HtmlPlugin;
let policy: string;
let transformed: string;

function parseDirectives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

beforeAll(async () => {
  const config = (await import('../../vite.config.ts')).default;
  // Vite plugin arrays nest (react() returns an array). Flattened by hand —
  // `.flat(Infinity)` blows TypeScript's recursion budget on vite's plugin type.
  const flatten = (value: unknown): unknown[] =>
    Array.isArray(value) ? value.flatMap(flatten) : [value];
  const plugins = flatten(config.plugins ?? []) as HtmlPlugin[];
  const found = plugins.find((p) => p && p.name === 'cyboflow-csp');
  if (!found) throw new Error('cyboflow-csp plugin is not registered in vite.config');
  plugin = found;

  transformed = plugin.transformIndexHtml!(readFileSync(INDEX_HTML, 'utf8'));
  const match = transformed.match(
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
  );
  if (!match) throw new Error('no CSP meta injected');
  policy = match[1];
});

describe('plugin wiring', () => {
  it('is build-only, so the dev server keeps its inline HMR scripts', () => {
    expect(plugin.apply).toBe('build');
  });

  it('runs post, after vite has injected its own bundle tags', () => {
    expect(plugin.enforce).toBe('post');
  });

  it('injects exactly one policy, after <meta charset> so charset stays in the first 1024 bytes', () => {
    expect(transformed.match(/Content-Security-Policy/g)).toHaveLength(1);
    const charsetAt = transformed.search(/<meta[^>]*charset=/i);
    const cspAt = transformed.search(/Content-Security-Policy/);
    expect(charsetAt).toBeGreaterThanOrEqual(0);
    expect(charsetAt).toBeLessThan(cspAt);
    expect(charsetAt).toBeLessThan(1024);
  });
});

describe('script-src', () => {
  it('does NOT allow unsafe-inline — injected markup must not execute', () => {
    expect(parseDirectives(policy).get('script-src')).not.toContain(`'unsafe-inline'`);
  });

  it('does NOT allow unsafe-eval', () => {
    expect(policy).not.toContain('unsafe-eval');
  });

  it('carries a sha256 hash for EVERY inline script in index.html', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    // index.html has the two theme-bootstrap scripts; a vacuous match would
    // make the hash assertions below meaningless.
    expect(inline.length).toBeGreaterThanOrEqual(2);
    const scriptSrc = parseDirectives(policy).get('script-src') ?? [];
    for (const [, body] of inline) {
      const hash = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
      expect(scriptSrc).toContain(hash);
    }
  });

  it('allows the app bundle and nothing else — no CDN script host', () => {
    const scriptSrc = parseDirectives(policy).get('script-src') ?? [];
    expect(scriptSrc).toContain(`'self'`);
    expect(scriptSrc).not.toContain('https://cdn.jsdelivr.net');
    expect(policy).not.toContain('jsdelivr');
  });
});

describe('the rest of the policy', () => {
  it('hard-denies plugin content and <base> hijacking', () => {
    const d = parseDirectives(policy);
    expect(d.get('object-src')).toEqual([`'none'`]);
    expect(d.get('base-uri')).toEqual([`'none'`]);
    expect(d.get('form-action')).toEqual([`'none'`]);
  });

  it('has a default-src fallback so an unlisted directive is not wide open', () => {
    expect(parseDirectives(policy).get('default-src')).toEqual([`'self'`]);
  });

  it('permits the artifact canvases on their runtime-assigned loopback ports', () => {
    const frameSrc = parseDirectives(policy).get('frame-src') ?? [];
    expect(frameSrc).toContain('http://127.0.0.1:*');
    expect(frameSrc).toContain('http://localhost:*');
  });

  it('permits base64 data: images — artifact screenshots arrive that way over IPC', () => {
    expect(parseDirectives(policy).get('img-src')).toContain('data:');
  });

  it('omits the directives <meta> delivery ignores, rather than logging warnings', () => {
    expect(policy).not.toContain('frame-ancestors');
    expect(policy).not.toContain('report-uri');
    expect(policy).not.toMatch(/(^|;)\s*sandbox\b/);
  });
});
