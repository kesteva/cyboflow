/**
 * StaticServerManager (S9) unit tests.
 *
 * These exercise the REAL http server against tiny fixture files written to a
 * tmpdir (no mocked fs/http) so the suite proves the actual path-safety
 * pipeline, not a stand-in. Most requests are driven with global `fetch`
 * against the tokenized baseUrl the handle returns.
 *
 * ONE exception: the raw (non-percent-encoded) `../` traversal case is driven
 * with node:http directly instead of fetch. The WHATWG URL algorithm that
 * fetch() uses to build a request NORMALIZES dot-segments in the pathname
 * BEFORE the request is ever sent — `new URL('http://h/tok/../x').pathname`
 * is already `/x`, so a literal `..` can never reach our server with the
 * token prefix intact via fetch. node:http's `options.path` is sent verbatim
 * (no client-side normalization), which is what actually exercises the
 * server's own containment check for a raw traversal attempt.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import http from 'node:http';
import { StaticServerManager } from '../staticServerManager';

/** Split a handle's baseUrl into its origin + minted token. */
function parseBaseUrl(baseUrl: string): { origin: string; token: string } {
  const url = new URL(baseUrl);
  const [token] = url.pathname.split('/').filter((s) => s.length > 0);
  return { origin: url.origin, token };
}

/**
 * Issue a request with a RAW, unnormalized path (bypassing WHATWG URL dot-
 * segment collapsing) — see file header. Resolves the response status only;
 * the body is drained and discarded.
 */
function rawRequest(origin: string, rawPath: string, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: rawPath, method },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('StaticServerManager', () => {
  it('serves the entry html and a sibling asset with correct content-type + nosniff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    try {
      await writeFile(join(root, 'index.html'), '<html><body>hi</body></html>');
      await writeFile(join(root, 'style.css'), 'body { color: red; }');

      const mgr = new StaticServerManager();
      const ac = new AbortController();
      const handle = await mgr.spawn({
        absoluteHtmlPath: join(root, 'index.html'),
        staticRoot: root,
        signal: ac.signal,
      });
      try {
        const htmlRes = await fetch(handle.baseUrl);
        expect(htmlRes.status).toBe(200);
        expect(htmlRes.headers.get('content-type')).toMatch(/text\/html/);
        expect(htmlRes.headers.get('x-content-type-options')).toBe('nosniff');
        expect(htmlRes.headers.get('cache-control')).toBe('no-store');
        expect(await htmlRes.text()).toContain('hi');

        const { origin, token } = parseBaseUrl(handle.baseUrl);
        const cssRes = await fetch(`${origin}/${token}/style.css`);
        expect(cssRes.status).toBe(200);
        expect(cssRes.headers.get('content-type')).toMatch(/text\/css/);
        expect(cssRes.headers.get('x-content-type-options')).toBe('nosniff');
        expect(await cssRes.text()).toContain('color: red');
      } finally {
        await handle.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('404s a request with no token and with a wrong token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    try {
      await writeFile(join(root, 'index.html'), '<html></html>');
      const mgr = new StaticServerManager();
      const handle = await mgr.spawn({
        absoluteHtmlPath: join(root, 'index.html'),
        staticRoot: root,
        signal: new AbortController().signal,
      });
      try {
        const { origin } = parseBaseUrl(handle.baseUrl);
        const noToken = await fetch(`${origin}/index.html`);
        expect(noToken.status).toBe(404);

        const wrongToken = await fetch(`${origin}/deadbeefdeadbeefdeadbeefdeadbeef/index.html`);
        expect(wrongToken.status).toBe(404);
      } finally {
        await handle.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('404s ../ traversal both raw (unencoded) and URL-encoded (%2e%2e%2f)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    const outside = await mkdtemp(join(tmpdir(), 'cvv-outside-'));
    try {
      await writeFile(join(root, 'index.html'), '<html></html>');
      await mkdir(join(root, 'sub'), { recursive: true });
      await writeFile(join(outside, 'secret.txt'), 'top secret');

      const mgr = new StaticServerManager();
      const handle = await mgr.spawn({
        absoluteHtmlPath: join(root, 'index.html'),
        staticRoot: root,
        signal: new AbortController().signal,
      });
      try {
        const { origin, token } = parseBaseUrl(handle.baseUrl);

        // Raw literal traversal via node:http (fetch would normalize this away
        // before it ever left the client — see file header).
        const rawStatus = await rawRequest(origin, `/${token}/sub/../../../../etc/passwd`);
        expect(rawStatus).toBe(404);

        // URL-encoded traversal reaches the server with literal "%2e%2e%2f"
        // text (fetch does NOT decode percent-escapes client-side), decoded by
        // OUR server into "../" and caught by the containment check. `root`
        // and `outside` are SIBLING tmpdirs (same parent), so "sub/../.."
        // decodes to exactly one level above staticRoot — its parent — from
        // which `outside`'s basename reaches the sibling directory.
        const encodedRes = await fetch(
          `${origin}/${token}/sub/%2e%2e%2f%2e%2e%2f${basename(outside)}/secret.txt`,
        );
        expect(encodedRes.status).toBe(404);
      } finally {
        await handle.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('404s a dotfile (.env) and a node_modules path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    try {
      await writeFile(join(root, 'index.html'), '<html></html>');
      await writeFile(join(root, '.env'), 'SECRET=1');
      await mkdir(join(root, 'node_modules'), { recursive: true });
      await writeFile(join(root, 'node_modules', 'pkg.js'), 'module.exports = {};');

      const mgr = new StaticServerManager();
      const handle = await mgr.spawn({
        absoluteHtmlPath: join(root, 'index.html'),
        staticRoot: root,
        signal: new AbortController().signal,
      });
      try {
        const { origin, token } = parseBaseUrl(handle.baseUrl);
        const envRes = await fetch(`${origin}/${token}/.env`);
        expect(envRes.status).toBe(404);

        const nodeModulesRes = await fetch(`${origin}/${token}/node_modules/pkg.js`);
        expect(nodeModulesRes.status).toBe(404);
      } finally {
        await handle.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('404s a case-variant node_modules path (case-insensitive fs bypass)', async () => {
    // On the primary platform (macOS APFS, case-insensitive) NODE_MODULES/pkg.js
    // resolves to the SAME file as node_modules/pkg.js — an exact-string denylist
    // would serve it. The denylist must compare case-insensitively.
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    try {
      await writeFile(join(root, 'index.html'), '<html></html>');
      await mkdir(join(root, 'node_modules'), { recursive: true });
      await writeFile(join(root, 'node_modules', 'pkg.js'), 'module.exports = {};');

      const mgr = new StaticServerManager();
      const handle = await mgr.spawn({
        absoluteHtmlPath: join(root, 'index.html'),
        staticRoot: root,
        signal: new AbortController().signal,
      });
      try {
        const { origin, token } = parseBaseUrl(handle.baseUrl);
        for (const variant of ['NODE_MODULES', 'Node_Modules', 'nOdE_mOdUlEs']) {
          const res = await fetch(`${origin}/${token}/${variant}/pkg.js`);
          expect(res.status).toBe(404);
        }
      } finally {
        await handle.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('404s a symlink inside the root that aliases a denied dir (post-realpath denylist)', async () => {
    // `x -> node_modules` sits INSIDE staticRoot, so both containment checks
    // pass and the request path shows only the innocuous segment `x` — the
    // denylist must be re-run over the realpath to catch the aliased identity.
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    try {
      await writeFile(join(root, 'index.html'), '<html></html>');
      await mkdir(join(root, 'node_modules'), { recursive: true });
      await writeFile(join(root, 'node_modules', 'pkg.js'), 'module.exports = {};');
      await symlink(join(root, 'node_modules'), join(root, 'x'));

      const mgr = new StaticServerManager();
      const handle = await mgr.spawn({
        absoluteHtmlPath: join(root, 'index.html'),
        staticRoot: root,
        signal: new AbortController().signal,
      });
      try {
        const { origin, token } = parseBaseUrl(handle.baseUrl);
        const res = await fetch(`${origin}/${token}/x/pkg.js`);
        expect(res.status).toBe(404);
      } finally {
        await handle.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('405s a POST request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    try {
      await writeFile(join(root, 'index.html'), '<html></html>');
      const mgr = new StaticServerManager();
      const handle = await mgr.spawn({
        absoluteHtmlPath: join(root, 'index.html'),
        staticRoot: root,
        signal: new AbortController().signal,
      });
      try {
        const res = await fetch(handle.baseUrl, { method: 'POST' });
        expect(res.status).toBe(405);
      } finally {
        await handle.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('404s a request for a directory (no listing, no implicit index.html)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    try {
      await writeFile(join(root, 'index.html'), '<html></html>');
      await mkdir(join(root, 'sub'), { recursive: true });
      await writeFile(join(root, 'sub', 'index.html'), '<html>nested</html>');

      const mgr = new StaticServerManager();
      const handle = await mgr.spawn({
        absoluteHtmlPath: join(root, 'index.html'),
        staticRoot: root,
        signal: new AbortController().signal,
      });
      try {
        const { origin, token } = parseBaseUrl(handle.baseUrl);
        const res = await fetch(`${origin}/${token}/sub`);
        expect(res.status).toBe(404);
      } finally {
        await handle.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('404s a symlink pointing outside staticRoot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    const outside = await mkdtemp(join(tmpdir(), 'cvv-outside-'));
    try {
      await writeFile(join(root, 'index.html'), '<html></html>');
      await writeFile(join(outside, 'secret.txt'), 'top secret');
      await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));

      const mgr = new StaticServerManager();
      const handle = await mgr.spawn({
        absoluteHtmlPath: join(root, 'index.html'),
        staticRoot: root,
        signal: new AbortController().signal,
      });
      try {
        const { origin, token } = parseBaseUrl(handle.baseUrl);
        const res = await fetch(`${origin}/${token}/escape.txt`);
        expect(res.status).toBe(404);
      } finally {
        await handle.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('release() closes the server (subsequent fetch rejects) and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    try {
      await writeFile(join(root, 'index.html'), '<html></html>');
      const mgr = new StaticServerManager();
      const handle = await mgr.spawn({
        absoluteHtmlPath: join(root, 'index.html'),
        staticRoot: root,
        signal: new AbortController().signal,
      });

      const before = await fetch(handle.baseUrl);
      expect(before.status).toBe(200);

      await handle.release();
      await expect(fetch(handle.baseUrl)).rejects.toThrow();

      // Idempotent — a second release must not throw.
      await expect(handle.release()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects spawn immediately when the signal is already aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvv-static-'));
    try {
      await writeFile(join(root, 'index.html'), '<html></html>');
      const mgr = new StaticServerManager();
      const ac = new AbortController();
      ac.abort();
      await expect(
        mgr.spawn({
          absoluteHtmlPath: join(root, 'index.html'),
          staticRoot: root,
          signal: ac.signal,
        }),
      ).rejects.toThrow(/aborted/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
