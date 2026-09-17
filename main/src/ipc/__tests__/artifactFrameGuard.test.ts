/**
 * Unit tests for artifactFrameGuard — the pure navigation-confinement predicate
 * behind the main-process `will-frame-navigate` interception that keeps a static
 * ui-prototype/generic mockup frame (about:srcdoc, bare sandbox) from navigating
 * (and thus beaconing) off its own document.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  shouldBlockArtifactFrameNavigation,
  isExternallyOpenable,
  isSafeExternalOpenTarget,
  shouldBlockScriptedFrameNavigation,
  shouldBlockScriptedFrameNavigationFromRegistry,
  registerScriptedFrameOrigin,
  unregisterScriptedFrameOrigin,
  scriptedFrameOriginsSnapshot,
} from '../artifactFrameGuard';

describe('shouldBlockArtifactFrameNavigation', () => {
  it('BLOCKS an about:srcdoc frame navigating to an http(s) URL (the beacon vector)', () => {
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'https://attacker.example/beacon', false)).toBe(true);
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'http://evil/x', false)).toBe(true);
  });

  it('BLOCKS an about:srcdoc frame navigating to data:/file:/custom schemes', () => {
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'data:text/html,x', false)).toBe(true);
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'file:///etc/passwd', false)).toBe(true);
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'weird://x', false)).toBe(true);
  });

  it('ALLOWS the initial about:srcdoc / about:blank load of the frame', () => {
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'about:srcdoc', false)).toBe(false);
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'about:blank', false)).toBe(false);
  });

  it('NEVER touches the app main frame', () => {
    expect(shouldBlockArtifactFrameNavigation('about:srcdoc', 'https://evil/x', true)).toBe(false);
    expect(shouldBlockArtifactFrameNavigation('file:///app/index.html', 'https://evil/x', true)).toBe(false);
  });

  it('NEVER touches the legacy localhost dev-server prototype iframe (not about:srcdoc)', () => {
    // A real cross-origin app frame that legitimately navigates itself.
    expect(shouldBlockArtifactFrameNavigation('http://localhost:8081', 'http://localhost:8081/page', false)).toBe(false);
    expect(shouldBlockArtifactFrameNavigation('http://localhost:8081', 'https://cdn.example/x', false)).toBe(false);
  });
});

describe('isExternallyOpenable', () => {
  it('is true only for http(s) targets', () => {
    expect(isExternallyOpenable('https://x/y')).toBe(true);
    expect(isExternallyOpenable('http://x')).toBe(true);
    expect(isExternallyOpenable('data:text/html,x')).toBe(false);
    expect(isExternallyOpenable('file:///x')).toBe(false);
    expect(isExternallyOpenable('mailto:a@b.c')).toBe(false);
  });
});

// Design Mode v1 — the scripted-frame (loopback-origin) guard.
const ORIGIN = 'http://127.0.0.1:9000';
const OTHER_ORIGIN = 'http://127.0.0.1:9100';
const origins = new Set([ORIGIN]);

describe('shouldBlockScriptedFrameNavigation', () => {
  it('ALLOWS a same-origin navigation (reload / respawn / same-origin hop)', () => {
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/index.html`, `${ORIGIN}/tok/prototype/index.html`, false, origins)).toBe(false);
    // Bare origin (reload) and a same-origin sub-path both allowed.
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/index.html`, ORIGIN, false, origins)).toBe(false);
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/a`, `${ORIGIN}/b`, false, origins)).toBe(false);
  });

  it('ALLOWS the initial about:blank / empty-frame load TO a registered origin', () => {
    expect(shouldBlockScriptedFrameNavigation('about:blank', `${ORIGIN}/tok/prototype/index.html`, false, origins)).toBe(false);
    expect(shouldBlockScriptedFrameNavigation('', `${ORIGIN}/tok/prototype/index.html`, false, origins)).toBe(false);
  });

  it('BLOCKS a confined frame navigating cross-origin http(s) (no external open path)', () => {
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/index.html`, 'https://attacker.example/beacon', false, origins)).toBe(true);
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/index.html`, `${OTHER_ORIGIN}/x`, false, origins)).toBe(true);
  });

  it('BLOCKS a confined frame navigating to about:/data:/file: schemes', () => {
    for (const target of ['about:blank', 'about:srcdoc', 'data:text/html,x', 'file:///etc/passwd', 'weird://x']) {
      expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/index.html`, target, false, origins)).toBe(true);
    }
  });

  it('does NOT confuse a sibling-port origin for the registered one', () => {
    // Target at :90001 must not be treated as same-origin with :9000.
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/a`, 'http://127.0.0.1:90001/a', false, origins)).toBe(true);
  });

  it('NEVER confines the app main frame', () => {
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/a`, 'https://evil/x', true, origins)).toBe(false);
  });

  it('leaves a non-registered-origin frame alone (returns false, deferring to other guards)', () => {
    expect(shouldBlockScriptedFrameNavigation('http://localhost:8081', 'https://cdn.example/x', false, origins)).toBe(false);
    expect(shouldBlockScriptedFrameNavigation('about:srcdoc', 'https://evil/x', false, origins)).toBe(false);
  });
});

describe('scripted-frame origin registry + shell.openExternal invariant', () => {
  it('registers / unregisters origins the live wrapper reads', () => {
    registerScriptedFrameOrigin(ORIGIN);
    expect(scriptedFrameOriginsSnapshot()).toContain(ORIGIN);
    expect(shouldBlockScriptedFrameNavigationFromRegistry(`${ORIGIN}/a`, 'https://evil/x', false)).toBe(true);
    unregisterScriptedFrameOrigin(ORIGIN);
    expect(scriptedFrameOriginsSnapshot()).not.toContain(ORIGIN);
    // Once unregistered, the frame is no longer ours — the scripted guard defers.
    expect(shouldBlockScriptedFrameNavigationFromRegistry(`${ORIGIN}/a`, 'https://evil/x', false)).toBe(false);
  });

  it('NEVER offers a blocked scripted-frame target to shell.openExternal', () => {
    // Mirrors the will-frame-navigate handler ordering (scripted guard first,
    // srcdoc guard second): a blocked scripted-frame navigation must preventDefault
    // and do NOTHING else — no OS-browser open, even for an http(s) target.
    registerScriptedFrameOrigin(ORIGIN);
    const openExternal = vi.fn();
    const handle = (frameUrl: string, targetUrl: string, isMainFrame: boolean): void => {
      if (shouldBlockScriptedFrameNavigationFromRegistry(frameUrl, targetUrl, isMainFrame)) {
        return; // preventDefault + nothing else
      }
      if (shouldBlockArtifactFrameNavigation(frameUrl, targetUrl, isMainFrame)) {
        if (isExternallyOpenable(targetUrl)) openExternal(targetUrl);
      }
    };
    handle(`${ORIGIN}/tok/prototype/index.html`, 'https://attacker.example/beacon?secrets=1', false);
    handle(`${ORIGIN}/tok/prototype/index.html`, 'http://evil/x', false);
    expect(openExternal).not.toHaveBeenCalled();
    unregisterScriptedFrameOrigin(ORIGIN);
  });
});

// Custom Views tier-3 widget document server (docs/proposals/CUSTOM-VIEWS.md
// §5.4, §9 row S3) — CustomWidgetServerManager registers its origin through the
// SAME registerScriptedFrameOrigin/unregisterScriptedFrameOrigin the design
// prototype server uses (main/src/services/customWidgetServer.ts). The guard
// functions above are origin-shaped and already generic; this block confirms
// that holds for a widget-server-style path (`/<token>/widget/<id>/<rev>`) too:
// a registered widget origin is confined exactly like a prototype origin, and
// a blocked navigation is NEVER offered to shell.openExternal.
describe('scripted-frame guard — Custom Views widget-server origin', () => {
  const WIDGET_URL = `${ORIGIN}/tok/widget/w1/3`;

  it('BLOCKS a widget frame navigating cross-origin http(s) (no external open path)', () => {
    registerScriptedFrameOrigin(ORIGIN);
    expect(shouldBlockScriptedFrameNavigation(WIDGET_URL, 'https://attacker.example/beacon', false, origins)).toBe(true);
    expect(shouldBlockScriptedFrameNavigationFromRegistry(WIDGET_URL, 'https://attacker.example/beacon', false)).toBe(true);
    unregisterScriptedFrameOrigin(ORIGIN);
  });

  it('ALLOWS a same-origin reload of the widget document', () => {
    registerScriptedFrameOrigin(ORIGIN);
    expect(shouldBlockScriptedFrameNavigationFromRegistry(WIDGET_URL, WIDGET_URL, false)).toBe(false);
    unregisterScriptedFrameOrigin(ORIGIN);
  });

  it('NEVER offers a blocked widget-frame target to shell.openExternal', () => {
    registerScriptedFrameOrigin(ORIGIN);
    const openExternal = vi.fn();
    const handle = (frameUrl: string, targetUrl: string, isMainFrame: boolean): void => {
      if (shouldBlockScriptedFrameNavigationFromRegistry(frameUrl, targetUrl, isMainFrame)) {
        return; // preventDefault + nothing else
      }
      if (shouldBlockArtifactFrameNavigation(frameUrl, targetUrl, isMainFrame)) {
        if (isExternallyOpenable(targetUrl)) openExternal(targetUrl);
      }
    };
    handle(WIDGET_URL, 'https://attacker.example/beacon?data=1', false);
    handle(WIDGET_URL, 'http://evil/x', false);
    expect(openExternal).not.toHaveBeenCalled();
    unregisterScriptedFrameOrigin(ORIGIN);
  });

  it('once unregistered, a widget origin is no longer confined (defers to other guards)', () => {
    expect(scriptedFrameOriginsSnapshot()).not.toContain(ORIGIN);
    expect(shouldBlockScriptedFrameNavigationFromRegistry(WIDGET_URL, 'https://evil/x', false)).toBe(false);
  });
});

// Design Mode v1 comment mode — the frozen-capture frame, hosted on the SAME
// loopback origin as the prototype but confined harder (design-mode.md "Comment
// mode": CSP does not govern document navigation, so the guard is what keeps a
// captured <a href> / form submit / meta refresh from moving the frame).
const COMMENT_URL = `${ORIGIN}/tok/comment/abc123.html`;
const PROTOTYPE_URL = `${ORIGIN}/tok/prototype/index.html`;

describe('shouldBlockScriptedFrameNavigation — comment frames', () => {
  it('BLOCKS SAME-ORIGIN navigation from a comment frame (a captured link must not move it)', () => {
    expect(shouldBlockScriptedFrameNavigation(COMMENT_URL, `${ORIGIN}/tok/comment/abc123.html`, false, origins)).toBe(true);
    expect(shouldBlockScriptedFrameNavigation(COMMENT_URL, `${ORIGIN}/tok/prototype/index.html`, false, origins)).toBe(true);
    expect(shouldBlockScriptedFrameNavigation(COMMENT_URL, ORIGIN, false, origins)).toBe(true);
    expect(shouldBlockScriptedFrameNavigation(COMMENT_URL, `${ORIGIN}/tok/comment/other.html`, false, origins)).toBe(true);
  });

  it('BLOCKS cross-origin and about:/data:/file: navigation from a comment frame', () => {
    for (const target of [
      'https://attacker.example/beacon',
      `${OTHER_ORIGIN}/x`,
      'about:blank',
      'about:srcdoc',
      'data:text/html,x',
      'file:///etc/passwd',
    ]) {
      expect(shouldBlockScriptedFrameNavigation(COMMENT_URL, target, false, origins)).toBe(true);
    }
  });

  it('BLOCKS regardless of a query string or fragment on the comment url', () => {
    expect(shouldBlockScriptedFrameNavigation(`${COMMENT_URL}?r=2`, `${ORIGIN}/a`, false, origins)).toBe(true);
    expect(shouldBlockScriptedFrameNavigation(`${COMMENT_URL}#top`, `${ORIGIN}/a`, false, origins)).toBe(true);
  });

  it('still ALLOWS the initial about:blank load of a comment frame (the parent setting src)', () => {
    expect(shouldBlockScriptedFrameNavigation('about:blank', COMMENT_URL, false, origins)).toBe(false);
    expect(shouldBlockScriptedFrameNavigation('', COMMENT_URL, false, origins)).toBe(false);
  });

  it('NEVER confines the app main frame, even at a comment url', () => {
    expect(shouldBlockScriptedFrameNavigation(COMMENT_URL, 'https://evil/x', true, origins)).toBe(false);
  });

  it('leaves PROTOTYPE-frame allowances byte-for-byte intact', () => {
    // Same-origin hops the prototype frame legitimately makes (reload / respawn).
    expect(shouldBlockScriptedFrameNavigation(PROTOTYPE_URL, PROTOTYPE_URL, false, origins)).toBe(false);
    expect(shouldBlockScriptedFrameNavigation(PROTOTYPE_URL, `${PROTOTYPE_URL}?r=1`, false, origins)).toBe(false);
    expect(shouldBlockScriptedFrameNavigation(PROTOTYPE_URL, ORIGIN, false, origins)).toBe(false);
    // …and everything off-origin still blocked.
    expect(shouldBlockScriptedFrameNavigation(PROTOTYPE_URL, 'https://attacker.example/x', false, origins)).toBe(true);
  });

  it('does not treat a non-comment path containing the word as a comment frame', () => {
    // The segment must sit directly under the token: `/comments/…` and a nested
    // `/tok/prototype/comment/…` are prototype-frame paths.
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/comments/x.html`, `${ORIGIN}/a`, false, origins)).toBe(false);
    expect(shouldBlockScriptedFrameNavigation(`${ORIGIN}/tok/prototype/comment/x`, `${ORIGIN}/a`, false, origins)).toBe(false);
  });
});

describe('comment frames never reach the OS browser', () => {
  it('NEVER offers a blocked comment-frame target to shell.openExternal', () => {
    registerScriptedFrameOrigin(ORIGIN);
    const openExternal = vi.fn();
    const handle = (frameUrl: string, targetUrl: string): void => {
      if (shouldBlockScriptedFrameNavigationFromRegistry(frameUrl, targetUrl, false)) return;
      if (shouldBlockArtifactFrameNavigation(frameUrl, targetUrl, false)) {
        if (isExternallyOpenable(targetUrl)) openExternal(targetUrl);
      }
    };
    for (const target of [
      'https://attacker.example/beacon?secrets=1',
      'http://evil/x',
      `${ORIGIN}/tok/prototype/index.html`,
      'about:blank',
    ]) {
      handle(COMMENT_URL, target);
    }
    expect(openExternal).not.toHaveBeenCalled();
    unregisterScriptedFrameOrigin(ORIGIN);
  });
});

// ===========================================================================
// isSafeExternalOpenTarget — the scheme allowlist in front of shell.openExternal
// for RENDERER-SUPPLIED urls (the `openExternal` IPC channel and the main
// window's setWindowOpenHandler). shell.openExternal is an OS launcher, not a
// browser, so an unfiltered url is an OS-level launch primitive reachable from
// a renderer XSS.
// ===========================================================================
describe('isSafeExternalOpenTarget', () => {
  it('ALLOWS the web + mail schemes the app legitimately opens', () => {
    for (const url of [
      'https://github.com/kesteva/cyboflow',
      'https://docs.anthropic.com/en/docs/claude-code',
      'http://localhost:8081/preview',
      'mailto:support@cyboflow.com?subject=Bug',
    ]) {
      expect(isSafeExternalOpenTarget(url)).toBe(true);
    }
  });

  it('BLOCKS file: — shell.openExternal opens a local document in its registered app', () => {
    expect(isSafeExternalOpenTarget('file:///Users/me/.ssh/id_rsa')).toBe(false);
    expect(isSafeExternalOpenTarget('file:///Applications/Calculator.app')).toBe(false);
  });

  it('BLOCKS javascript: and data:', () => {
    expect(isSafeExternalOpenTarget('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalOpenTarget('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('BLOCKS platform + custom schemes that drive system UI or another app', () => {
    for (const url of [
      'x-apple.systempreferences:com.apple.preference.security',
      'ms-settings:privacy',
      'smb://attacker.example/share',
      'vscode://file/etc/passwd',
      'chrome://settings',
    ]) {
      expect(isSafeExternalOpenTarget(url)).toBe(false);
    }
  });

  it('BLOCKS anything that is not a parseable absolute URL', () => {
    expect(isSafeExternalOpenTarget('')).toBe(false);
    expect(isSafeExternalOpenTarget('/etc/passwd')).toBe(false);
    expect(isSafeExternalOpenTarget('github.com')).toBe(false);
  });

  it('judges the PARSED scheme, so leading whitespace cannot smuggle one past', () => {
    // The URL parser strips leading whitespace before determining the scheme,
    // which is why the decision is made on `new URL(...).protocol` rather than a
    // prefix match: a padded javascript: url is still javascript:.
    expect(isSafeExternalOpenTarget('  https://ok.example')).toBe(true);
    expect(isSafeExternalOpenTarget('  javascript:alert(1)')).toBe(false);
    expect(isSafeExternalOpenTarget('\n\tfile:///etc/passwd')).toBe(false);
  });

  it('is deliberately WIDER than isExternallyOpenable by exactly mailto:', () => {
    // isExternallyOpenable governs a HOSTILE artifact frame, where popping a
    // mail composer is not something a mockup should be able to do.
    expect(isExternallyOpenable('mailto:x@y.z')).toBe(false);
    expect(isSafeExternalOpenTarget('mailto:x@y.z')).toBe(true);
    // Everything else agrees.
    for (const url of ['https://a.example', 'http://b.example', 'file:///x', 'javascript:1']) {
      expect(isSafeExternalOpenTarget(url)).toBe(isExternallyOpenable(url));
    }
  });
});
