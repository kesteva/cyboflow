/**
 * webViewerTelemetry — ring buffers, cursors, the redacting writer, and
 * request-id correlation. docs/proposals/native-web-viewer.md §3.2–3.3.
 */
import { describe, expect, it } from 'vitest';
import { redactUrl, TELEMETRY_LIMITS, WebViewerTelemetry } from '../webViewerTelemetry';

const P = 'persist:cyboflow-web-viewer';

describe('redactUrl', () => {
  it('drops userinfo and fragment and replaces query VALUES, keeping keys', () => {
    expect(redactUrl('https://user:pw@example.com/p?token=abc&x=1#frag')).toBe(
      'https://example.com/p?token=%E2%80%A6&x=%E2%80%A6',
    );
  });

  it('never returns the raw string for something unparseable', () => {
    expect(redactUrl('not a url ?token=abc')).toBeNull();
    expect(redactUrl(undefined)).toBeNull();
  });
});

describe('WebViewerTelemetry console', () => {
  it('stores level, clipped text, redacted source and frame origin', () => {
    const t = new WebViewerTelemetry(() => 42);
    t.appendConsole('tab', {
      level: 'error',
      message: 'x'.repeat(TELEMETRY_LIMITS.maxText + 50),
      sourceId: 'https://cdn.example.com/app.js?sig=SECRET',
      lineNumber: 7,
      frame: { url: 'https://artifact.example.org/frame?k=SECRET' },
    });
    const read = t.read('tab', 'console');
    const [e] = read!.entries;
    expect(e.level).toBe('error');
    expect(e.message.length).toBe(TELEMETRY_LIMITS.maxText + 1);
    expect(e.frameOrigin).toBe('https://artifact.example.org');
    expect(JSON.stringify(read)).not.toContain('SECRET');
  });

  it('returns deltas after a cursor, and an EXACT gap when unseen entries were evicted', () => {
    const t = new WebViewerTelemetry();
    const total = TELEMETRY_LIMITS.console + 10;
    for (let i = 0; i < total; i += 1) t.appendConsole('tab', { level: 'info', message: `m${i}` });
    const first = t.read('tab', 'console', 0)!;
    expect(first.gap).toBe(10);
    expect(first.entries).toHaveLength(TELEMETRY_LIMITS.console);
    expect(first.cursor).toBe(total);

    t.appendConsole('tab', { level: 'info', message: 'next' });
    const delta = t.read('tab', 'console', first.cursor)!;
    expect(delta.entries.map((e) => e.message)).toEqual(['next']);
    expect(delta.gap).toBe(0);
  });

  it('keeps each kind on its own cursor — console traffic never shows as a network gap', () => {
    const t = new WebViewerTelemetry();
    for (let i = 0; i < TELEMETRY_LIMITS.console + 5; i += 1) t.appendConsole('tab', { level: 'info', message: 'x' });
    t.appendNavigation('tab', 'commit', 'https://example.com/');
    expect(t.read('tab', 'navigation', 0)).toMatchObject({ cursor: 1, gap: 0 });
  });

  it('reads null for an unknown tab and forgets a closed one', () => {
    const t = new WebViewerTelemetry();
    expect(t.read('nope', 'console')).toBeNull();
    t.appendConsole('tab', { level: 'info', message: 'x' });
    t.forget('tab');
    expect(t.read('tab', 'console')).toBeNull();
  });
});

describe('WebViewerTelemetry network', () => {
  const done = (over: Partial<Parameters<WebViewerTelemetry['requestFinished']>[1]> = {}) => ({
    id: 1,
    url: 'https://api.example.com/v1?key=SECRET',
    method: 'GET',
    resourceType: 'xhr',
    timestamp: 1500,
    webContentsId: 7,
    statusCode: 200,
    fromCache: false,
    ...over,
  });

  it('correlates start → finish by request id for a duration', () => {
    const t = new WebViewerTelemetry();
    t.attach('tab', 7);
    t.requestStarted(P, { id: 1, timestamp: 1000 });
    t.requestFinished(P, done());
    const [e] = t.read('tab', 'network')!.entries;
    expect(e).toMatchObject({ status: 200, durationMs: 500, method: 'GET' });
    expect(e.url).not.toContain('SECRET');
  });

  it('reports NO duration when the start was never seen (never a fabricated one)', () => {
    const t = new WebViewerTelemetry();
    t.attach('tab', 7);
    t.requestFinished(P, done({ fromCache: true }));
    expect(t.read('tab', 'network')!.entries[0].durationMs).toBeNull();
  });

  it('files a request with no attributable tab under unattributed, not a wrong tab', () => {
    const t = new WebViewerTelemetry();
    t.attach('tab', 7);
    t.requestFinished(P, done({ webContentsId: undefined }));
    t.requestFinished(P, done({ id: 2, webContentsId: 99 }));
    expect(t.read('tab', 'network')!.entries).toHaveLength(0);
    expect(t.readUnattributed(P).entries).toHaveLength(2);
  });

  it('records failures with their error text', () => {
    const t = new WebViewerTelemetry();
    t.attach('tab', 7);
    t.requestFinished(P, done({ statusCode: undefined, error: 'net::ERR_CONNECTION_REFUSED' }));
    expect(t.read('tab', 'network')!.entries[0]).toMatchObject({
      status: null,
      error: 'net::ERR_CONNECTION_REFUSED',
    });
  });

  it('keeps a tab’s rings across a view swap but drops the old attribution', () => {
    const t = new WebViewerTelemetry();
    t.attach('tab', 7);
    t.requestFinished(P, done());
    t.detach(7);
    t.attach('tab', 8);
    t.requestFinished(P, done({ id: 2, webContentsId: 7 }));
    expect(t.read('tab', 'network')!.entries).toHaveLength(1);
    expect(t.readUnattributed(P).entries).toHaveLength(1);
  });
});
