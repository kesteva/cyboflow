/**
 * Path helpers for renderer-side display logic.
 *
 * Paths reach the renderer from producers that disagree on a separator: main's
 * fileOps returns `path.relative` output, git diff text is always forward-slash,
 * and Claude Code tool inputs carry native separators. A backslash separates
 * only on Windows; elsewhere it is a legal filename character, so treating it
 * as a separator truncates the name a user sees. `windows` defaults to the
 * running platform and is a parameter so both dialects are testable anywhere.
 *
 * These are DISPLAY helpers: they never normalize the surviving prefix.
 */
import { isWindowsPlatform } from './platform';

function trailingSeparators(windows: boolean): RegExp {
  return windows ? /[/\\]+$/ : /\/+$/;
}

function lastSeparatorIndex(p: string, windows: boolean): number {
  return windows ? Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) : p.lastIndexOf('/');
}

/**
 * Last path segment. Trailing separators are stripped first, so `'a/b/'` is
 * 'b'; '' for empty or all-separator input, and `'C:\'` reads as 'C:'.
 */
export function pathBasename(p: string, windows: boolean = isWindowsPlatform()): string {
  const trimmed = p.replace(trailingSeparators(windows), '');
  const idx = lastSeparatorIndex(trimmed, windows);
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * The directory prefix a file label shows, trailing separator included.
 */
export function pathDirPrefix(p: string, windows: boolean = isWindowsPlatform()): string {
  const idx = lastSeparatorIndex(p, windows);
  return idx === -1 ? '' : p.slice(0, idx + 1);
}
