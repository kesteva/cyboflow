/**
 * pathBasename / pathDirPrefix — path segment helpers.
 *
 * The matrix below is the specification: every path shape the renderer is
 * actually fed (posix workspace-relative, native Windows relative, Windows
 * absolute drive paths, mixed-separator joins, trailing-separator directory
 * paths) plus the empty/root sentinels.
 *
 * The dialect is passed explicitly rather than read from the host, so both
 * arms run everywhere. A backslash separates only on Windows: on POSIX it is
 * a legal filename character and must survive into the displayed name.
 */
import { describe, it, expect } from 'vitest';
import { pathBasename, pathDirPrefix } from '../pathBasename';

const WIN = true;
const POSIX = false;

describe('pathBasename', () => {
  it('reads the last segment of a posix relative path', () => {
    expect(pathBasename('src/utils/x.ts', POSIX)).toBe('x.ts');
    expect(pathBasename('src/utils/x.ts', WIN)).toBe('x.ts');
  });

  it('reads the last segment of a native Windows relative path', () => {
    expect(pathBasename('src\\utils\\x.ts', WIN)).toBe('x.ts');
  });

  it('reads the last segment of a Windows absolute drive path', () => {
    expect(pathBasename('C:\\repo\\src\\x.ts', WIN)).toBe('x.ts');
  });

  it('handles mixed separators (renderer-built posix subpath on a native root)', () => {
    expect(pathBasename('C:\\repo\\src/utils\\x.ts', WIN)).toBe('x.ts');
    expect(pathBasename('a/b\\c.md', WIN)).toBe('c.md');
  });

  it('keeps a backslash as part of the name on POSIX, where it is legal', () => {
    // A macOS file really can be called `weird\name.ts`. Splitting on the
    // backslash there truncated the displayed name.
    expect(pathBasename('src/weird\\name.ts', POSIX)).toBe('weird\\name.ts');
    expect(pathBasename('a\\b.md', POSIX)).toBe('a\\b.md');
    expect(pathBasename('dir\\', POSIX)).toBe('dir\\');
  });

  it('strips trailing separators, so a directory path yields its own name', () => {
    expect(pathBasename('a/b/', POSIX)).toBe('b');
    expect(pathBasename('a\\b\\', WIN)).toBe('b');
    expect(pathBasename('a/b//', POSIX)).toBe('b');
  });

  it('reads a drive root as the drive label', () => {
    expect(pathBasename('C:\\', WIN)).toBe('C:');
    expect(pathBasename('/', POSIX)).toBe('');
  });

  it('returns the whole input when it has no separator', () => {
    expect(pathBasename('foo.ts', POSIX)).toBe('foo.ts');
    expect(pathBasename('foo.ts', WIN)).toBe('foo.ts');
  });

  it('returns "" for empty and all-separator input', () => {
    expect(pathBasename('', POSIX)).toBe('');
    expect(pathBasename('///', POSIX)).toBe('');
    expect(pathBasename('\\\\', WIN)).toBe('');
  });
});

describe('pathDirPrefix', () => {
  it('keeps the trailing separator, because the label displays it', () => {
    expect(pathDirPrefix('src/ui/Button.tsx', POSIX)).toBe('src/ui/');
    expect(pathDirPrefix('src\\ui\\Button.tsx', WIN)).toBe('src\\ui\\');
  });

  it('returns "" when there is no directory part', () => {
    expect(pathDirPrefix('Button.tsx', POSIX)).toBe('');
    expect(pathDirPrefix('weird\\name.ts', POSIX)).toBe('');
  });
});
