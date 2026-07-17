/**
 * Unit tests for artifactFrameGuard — the pure navigation-confinement predicate
 * behind the main-process `will-frame-navigate` interception that keeps a static
 * ui-prototype/generic mockup frame (about:srcdoc, bare sandbox) from navigating
 * (and thus beaconing) off its own document.
 */
import { describe, it, expect } from 'vitest';
import { shouldBlockArtifactFrameNavigation, isExternallyOpenable } from '../artifactFrameGuard';

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
