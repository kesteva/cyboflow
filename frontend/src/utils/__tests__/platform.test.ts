/**
 * isApplePlatform / kbdHint — platform detection for shortcut hint copy.
 *
 * Handlers accept both Meta and Ctrl everywhere; these helpers only decide
 * what the visible hint says ("⌘⏎" vs "Ctrl+Enter"). The navigator surface is
 * stubbed per case: userAgentData (Chromium), platform (Safari/Firefox/Edge),
 * then userAgent (last-resort fallback), plus the SSR "no navigator" guard.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isApplePlatform, isWindowsPlatform, kbdHint } from '../platform';

type NavStub = {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
};

function stubNavigator(nav: NavStub | undefined): void {
  vi.stubGlobal('navigator', nav);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isWindowsPlatform', () => {
  it('returns false when navigator is absent (SSR-safe)', () => {
    stubNavigator(undefined);
    expect(isWindowsPlatform()).toBe(false);
  });

  it('recognises Windows through each navigator surface', () => {
    stubNavigator({ userAgentData: { platform: 'Windows' } });
    expect(isWindowsPlatform()).toBe(true);

    stubNavigator({ platform: 'Win32' });
    expect(isWindowsPlatform()).toBe(true);

    stubNavigator({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    expect(isWindowsPlatform()).toBe(true);
  });

  it('is false on macOS and Linux', () => {
    stubNavigator({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' });
    expect(isWindowsPlatform()).toBe(false);

    stubNavigator({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' });
    expect(isWindowsPlatform()).toBe(false);
  });

  it('is not fooled by "Darwin", which contains "win"', () => {
    stubNavigator({ platform: 'Darwin', userAgent: 'node/Darwin' });
    expect(isWindowsPlatform()).toBe(false);
  });
});

describe('isApplePlatform', () => {
  it('returns false when navigator is absent (SSR-safe)', () => {
    stubNavigator(undefined);
    expect(isApplePlatform()).toBe(false);
  });

  it('reads userAgentData.platform first (Chromium family)', () => {
    stubNavigator({ userAgentData: { platform: 'macOS' }, platform: 'Win32' });
    expect(isApplePlatform()).toBe(true);

    stubNavigator({ userAgentData: { platform: 'Windows' } });
    expect(isApplePlatform()).toBe(false);
  });

  it('falls back to navigator.platform (Safari / Firefox / jsdom)', () => {
    stubNavigator({ platform: 'MacIntel' });
    expect(isApplePlatform()).toBe(true);

    stubNavigator({ platform: 'Win32' });
    expect(isApplePlatform()).toBe(false);

    stubNavigator({ platform: 'Linux x86_64' });
    expect(isApplePlatform()).toBe(false);
  });

  it('falls back to the userAgent when both narrower signals are missing', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    });
    expect(isApplePlatform()).toBe(true);

    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    });
    expect(isApplePlatform()).toBe(false);
  });

  it('treats the default jsdom navigator as non-Apple', () => {
    // No stub: jsdom's navigator has a non-mac UA and no platform. This is the
    // value every component test in this repo sees — hints render "Ctrl".
    expect(isApplePlatform()).toBe(false);
  });
});

describe('kbdHint', () => {
  it('spells Ctrl on non-Apple platforms', () => {
    stubNavigator({ platform: 'Win32' });
    expect(kbdHint('mod', 'P')).toBe('Ctrl+P');
    expect(kbdHint('mod', 'Enter')).toBe('Ctrl+Enter');
    expect(kbdHint('modShift', 'Enter')).toBe('Ctrl+Shift+Enter');
    expect(kbdHint('modShift', 'S')).toBe('Ctrl+Shift+S');
  });

  it('keeps the Apple glyphs on Apple platforms', () => {
    stubNavigator({ platform: 'MacIntel' });
    expect(kbdHint('mod', 'P')).toBe('⌘P');
    expect(kbdHint('mod', 'Enter')).toBe('⌘⏎');
    expect(kbdHint('modShift', 'Enter')).toBe('⌘⇧⏎');
    expect(kbdHint('modShift', 'S')).toBe('⌘⇧S');
  });

  it('uses the userAgent fallback for the glyph decision too', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
    expect(kbdHint('mod', 'Enter')).toBe('⌘⏎');

    stubNavigator(undefined);
    expect(kbdHint('mod', 'Enter')).toBe('Ctrl+Enter');
  });
});
