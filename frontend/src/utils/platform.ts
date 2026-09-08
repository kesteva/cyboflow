/**
 * Platform detection for shortcut HINT copy.
 *
 * Shortcut HANDLERS are already cross-platform — every "mod" handler accepts
 * both Meta (mac) and Ctrl (Windows/Linux) — so the platform only matters for
 * the visible hint text: Apple platforms keep their ⌘ glyphs, everything else
 * spells "Ctrl". SSR-safe: every navigator access is guarded, so the module
 * imports fine from non-DOM contexts.
 */

/** navigator.userAgentData, where browsers expose it (Chromium-family). */
type NavigatorUAData = { platform?: string };

function applePlatformish(value: string | undefined | null): boolean {
  return /mac|iphone|ipad|ipod/i.test(value ?? '');
}

/** True on macOS / iOS / iPadOS — the platforms whose shortcut hints use ⌘. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: NavigatorUAData };
  return (
    applePlatformish(nav.userAgentData?.platform) ||
    applePlatformish(nav.platform) ||
    applePlatformish(nav.userAgent)
  );
}

/**
 * True on Windows. Used where the platform changes behaviour rather than copy:
 * a backslash separates path segments here and is a legal filename character
 * everywhere else. Never matches "Darwin": the platform probes are anchored.
 */
export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: NavigatorUAData };
  return (
    /^windows$/i.test(nav.userAgentData?.platform ?? '') ||
    /^win/i.test(nav.platform ?? '') ||
    /windows/i.test(nav.userAgent ?? '')
  );
}

/** Which modifiers a hinted shortcut carries, beyond the platform mod key. */
export type KbdCombo = 'mod' | 'modShift';

/** Apple's return-key glyph — spelled out as "Enter" elsewhere. */
const MAC_ENTER = '⏎';

/**
 * Platform-appropriate label for a shortcut, for titles / placeholders / kbd
 * chips. `key` is the non-modifier key ('P', 'Enter', …).
 *
 *   kbdHint('mod', 'Enter')        → '⌘⏎'  (Apple) | 'Ctrl+Enter'       (else)
 *   kbdHint('modShift', 'Enter')   → '⌘⇧⏎' (Apple) | 'Ctrl+Shift+Enter' (else)
 */
export function kbdHint(combo: KbdCombo, key: string): string {
  if (!isApplePlatform()) {
    const parts = combo === 'modShift' ? ['Ctrl', 'Shift', key] : ['Ctrl', key];
    return parts.join('+');
  }
  const mods = combo === 'modShift' ? '⌘⇧' : '⌘';
  return `${mods}${key === 'Enter' ? MAC_ENTER : key}`;
}
