import { describe, expect, it } from 'vitest';
import {
  HARNESS_NONCE_MARKER_SELECTOR,
  HARNESS_NONCE_MARKER_SPEC,
  injectNonceMarker,
  isHarnessNonceMarkerSpec,
  type NonceMarkerFs,
} from '../webNonceMarker';

const ROOT = '/snap';
const NONCE = '3f2c7a9e-1b4d-4e8f-9a0b-c1d2e3f4a5b6';

/** An in-memory fs keyed by absolute path; `writes` records every write. */
function memFs(files: Record<string, string>): NonceMarkerFs & { writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  return {
    writes,
    readRegularFile: async (absPath) => files[absPath] ?? null,
    writeFile: async (absPath, content) => {
      writes.push([absPath, content]);
    },
  };
}

const VITE_INDEX = '<!doctype html>\n<html lang="en">\n  <head>\n    <title>App</title>\n  </head>\n  <body></body>\n</html>\n';

describe('injectNonceMarker', () => {
  it('stamps the marker right after <head> in a Vite root index.html', async () => {
    const fs = memFs({ '/snap/index.html': VITE_INDEX });
    const result = await injectNonceMarker({ snapshotRoot: ROOT, nonce: NONCE, fs });
    expect(result.injected).toBe(true);
    if (!result.injected) return;
    expect(result.relPath).toBe('index.html');
    expect(fs.writes).toEqual([['/snap/index.html', result.content]]);
    expect(result.content).toContain(
      `<head>\n    <meta name="cyboflow-verify-nonce" content="${NONCE}" data-verify-nonce="${NONCE}">\n    <title>`,
    );
    // Only the one line was added.
    expect(result.content.replace(/\n {4}<meta name="cyboflow-verify-nonce"[^>]*>/, '')).toBe(VITE_INDEX);
  });

  it.each(['public/index.html', 'src/index.html', 'src/app.html'])('finds the %s layout', async (relPath) => {
    const fs = memFs({ [`/snap/${relPath}`]: '<html><head lang="x"></head><body>%sveltekit.body%</body></html>' });
    const result = await injectNonceMarker({ snapshotRoot: ROOT, nonce: NONCE, fs });
    expect(result).toMatchObject({ injected: true, relPath });
    if (result.injected) expect(result.content).toContain(`<head lang="x">\n    <meta name="cyboflow-verify-nonce"`);
  });

  it('does not mistake <header> for <head>', async () => {
    const fs = memFs({ '/snap/index.html': '<html><body><header>x</header></body></html>' });
    const result = await injectNonceMarker({ snapshotRoot: ROOT, nonce: NONCE, fs });
    expect(result).toEqual({ injected: false, reason: 'index.html has 0 <head> tags, expected exactly one' });
    expect(fs.writes).toEqual([]);
  });

  it('skips when there is no entry HTML file', async () => {
    const fs = memFs({ '/snap/package.json': '{"dependencies":{"vite":"5"}}' });
    const result = await injectNonceMarker({ snapshotRoot: ROOT, nonce: NONCE, fs });
    expect(result.injected).toBe(false);
    if (!result.injected) expect(result.reason).toMatch(/no entry HTML file/);
  });

  it('skips when more than one candidate exists (which is served is ambiguous)', async () => {
    const fs = memFs({ '/snap/index.html': VITE_INDEX, '/snap/public/index.html': VITE_INDEX });
    const result = await injectNonceMarker({ snapshotRoot: ROOT, nonce: NONCE, fs });
    expect(result.injected).toBe(false);
    if (!result.injected) expect(result.reason).toMatch(/index\.html, public\/index\.html/);
    expect(fs.writes).toEqual([]);
  });

  it.each(['next', 'nuxt', '@remix-run/dev', 'astro'])('skips a server-rendered %s app even with an index.html', async (dep) => {
    const fs = memFs({
      '/snap/package.json': JSON.stringify({ devDependencies: { [dep]: '1' } }),
      '/snap/index.html': VITE_INDEX,
    });
    const result = await injectNonceMarker({ snapshotRoot: ROOT, nonce: NONCE, fs });
    expect(result.injected).toBe(false);
    if (!result.injected) expect(result.reason).toContain(`"${dep}"`);
  });

  it('ignores an unparseable package.json rather than refusing', async () => {
    const fs = memFs({ '/snap/package.json': '{not json', '/snap/index.html': VITE_INDEX });
    expect((await injectNonceMarker({ snapshotRoot: ROOT, nonce: NONCE, fs })).injected).toBe(true);
  });

  it('skips when the head tag is repeated', async () => {
    const fs = memFs({ '/snap/index.html': '<head></head><head></head>' });
    const result = await injectNonceMarker({ snapshotRoot: ROOT, nonce: NONCE, fs });
    expect(result).toEqual({ injected: false, reason: 'index.html has 2 <head> tags, expected exactly one' });
  });

  it('refuses a nonce that is not attribute-safe', async () => {
    const fs = memFs({ '/snap/index.html': VITE_INDEX });
    const result = await injectNonceMarker({ snapshotRoot: ROOT, nonce: '"><script>', fs });
    expect(result.injected).toBe(false);
    expect(fs.writes).toEqual([]);
  });

  it('folds an fs failure into a skip instead of throwing', async () => {
    const fs: NonceMarkerFs = {
      readRegularFile: async (p) => (p === '/snap/index.html' ? VITE_INDEX : null),
      writeFile: async () => {
        throw new Error('EROFS');
      },
    };
    expect(await injectNonceMarker({ snapshotRoot: ROOT, nonce: NONCE, fs })).toEqual({
      injected: false,
      reason: 'injection failed: EROFS',
    });
  });
});

describe('isHarnessNonceMarkerSpec', () => {
  it('matches only the harness selector on dom-marker', () => {
    expect(isHarnessNonceMarkerSpec(HARNESS_NONCE_MARKER_SPEC)).toBe(true);
    expect(isHarnessNonceMarkerSpec({ kind: 'dom-marker', selector: '#app' })).toBe(false);
    expect(isHarnessNonceMarkerSpec({ kind: 'serve-binding' })).toBe(false);
    expect(isHarnessNonceMarkerSpec(undefined)).toBe(false);
    expect(HARNESS_NONCE_MARKER_SELECTOR).toBe('meta[name="cyboflow-verify-nonce"]');
  });
});
