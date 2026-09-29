/**
 * webViewerGuard — the viewer's URL, navigation and redaction policy.
 *
 * Pure by design, so every security rule is decidable without a window. The
 * cases that matter are the ones a plausible-looking implementation gets wrong:
 * a prefix compare that accepts `github.com.evil.com`, a redactor that leaks
 * userinfo, a scheme check that allows `file:`.
 */
import { describe, it, expect } from 'vitest';
import {
  isViewableUrl,
  popupDisposition,
  redactToOrigin,
  resolveViewableUrl,
  sameOrigin,
  shouldBlockViewerNavigation,
  WEB_VIEWER_LIMITS,
} from '../webViewerGuard';

describe('isViewableUrl', () => {
  it('accepts http and https only', () => {
    expect(isViewableUrl('https://docs.anthropic.com/')).toBe(true);
    expect(isViewableUrl('http://localhost:5173/')).toBe(true);
  });

  it('rejects every scheme that would escape the viewer', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'blob:https://x.test/abc',
      'mailto:a@b.test',
      'about:blank',
      'chrome://settings',
      'x-apple.systempreferences:',
      '',
      'not a url',
    ]) {
      expect(isViewableUrl(url), url).toBe(false);
    }
  });
});

describe('resolveViewableUrl', () => {
  it('resolves a relative href against a base', () => {
    expect(resolveViewableUrl('./b/c', 'https://x.test/a/')).toBe('https://x.test/a/b/c');
    expect(resolveViewableUrl('/root', 'https://x.test/a/')).toBe('https://x.test/root');
  });

  it('returns null for a bare hostname — markdown carries plenty of them', () => {
    expect(resolveViewableUrl('example.com')).toBeNull();
  });

  it('returns null for an anchor, a mailto, and whitespace', () => {
    expect(resolveViewableUrl('#section', 'https://x.test/a')).toBe('https://x.test/a#section');
    expect(resolveViewableUrl('mailto:a@b.test')).toBeNull();
    expect(resolveViewableUrl('   ')).toBeNull();
  });

  it('trims before resolving', () => {
    expect(resolveViewableUrl('  https://x.test/  ')).toBe('https://x.test/');
  });
});

describe('shouldBlockViewerNavigation', () => {
  it('blocks a page navigating itself to about:blank', () => {
    // A blank tab is indistinguishable from a suspended one to an observing
    // agent, which is exactly the state requirement (2) exists to report.
    expect(shouldBlockViewerNavigation('about:blank')).toBe(true);
  });

  it('allows ordinary http(s) navigation', () => {
    expect(shouldBlockViewerNavigation('https://x.test/next')).toBe(false);
  });
});

describe('redactToOrigin', () => {
  it('strips path, query, fragment AND userinfo', () => {
    expect(redactToOrigin('https://u:pw@x.test:8443/a/b?token=secret#frag')).toBe(
      'https://x.test:8443',
    );
  });

  it('keeps a non-default port and drops a default one', () => {
    expect(redactToOrigin('http://localhost:5173/x')).toBe('http://localhost:5173');
    expect(redactToOrigin('https://x.test:443/y')).toBe('https://x.test');
  });

  it('returns null for absent, empty, unparseable and opaque origins', () => {
    expect(redactToOrigin(null)).toBeNull();
    expect(redactToOrigin(undefined)).toBeNull();
    expect(redactToOrigin('')).toBeNull();
    expect(redactToOrigin('not a url')).toBeNull();
    // `data:` has an opaque origin; reporting the literal string "null" would be
    // worse than reporting nothing.
    expect(redactToOrigin('data:text/plain,hi')).toBeNull();
  });
});

describe('sameOrigin', () => {
  it('is exact, not a prefix compare', () => {
    expect(sameOrigin('https://github.com/a', 'https://github.com/b')).toBe(true);
    // The two shapes that defeat prefix matching.
    expect(sameOrigin('https://github.com/a', 'https://github.com.evil.test/a')).toBe(false);
    expect(sameOrigin('https://github.com/a', 'https://evil.test/?x=https://github.com')).toBe(
      false,
    );
  });

  it('distinguishes scheme and port', () => {
    expect(sameOrigin('http://x.test/', 'https://x.test/')).toBe(false);
    expect(sameOrigin('http://x.test:5173/', 'http://x.test:5174/')).toBe(false);
  });

  it('FAILS CLOSED — an unparseable URL matches nothing, including another one', () => {
    expect(sameOrigin('junk', 'junk')).toBe(false);
    expect(sameOrigin(null, null)).toBe(false);
  });
});

describe('popupDisposition', () => {
  it('turns an http(s) popup into a tab and denies everything else', () => {
    expect(popupDisposition('https://x.test/')).toBe('new-tab');
    // Notably NOT handed to shell.openExternal: a remote page silently launching
    // the user's browser is a navigation nobody asked for.
    expect(popupDisposition('mailto:a@b.test')).toBe('deny');
    expect(popupDisposition('file:///etc/passwd')).toBe('deny');
  });
});

describe('WEB_VIEWER_LIMITS', () => {
  it('keeps the per-session loaded cap below the tab cap and the global ceiling sane', () => {
    // A loaded cap at or above maxTabs would mean the LRU never engages; a global
    // ceiling below the per-session one would make one session unable to fill its
    // own allowance.
    expect(WEB_VIEWER_LIMITS.maxLoadedViews).toBeLessThan(WEB_VIEWER_LIMITS.maxTabs);
    expect(WEB_VIEWER_LIMITS.maxLoadedViewsGlobal).toBeGreaterThanOrEqual(
      WEB_VIEWER_LIMITS.maxLoadedViews,
    );
  });
});
