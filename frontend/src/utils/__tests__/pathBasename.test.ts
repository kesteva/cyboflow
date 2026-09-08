/**
 * pathBasename / parentPath / pathDirPrefix — path segment helpers.
 *
 * The matrix below is the specification: every path shape the renderer is
 * actually fed (posix workspace-relative, native Windows relative, Windows
 * absolute drive paths, mixed-separator joins, trailing-separator directory
 * paths) plus the empty/root sentinels FileEditor relies on.
 *
 * The dialect is passed explicitly rather than read from the host, so both
 * arms run everywhere. A backslash separates only on Windows: on POSIX it is
 * a legal filename character and must survive into the displayed name.
 */
import { describe, it, expect } from 'vitest';
import { pathBasename, parentPath, pathDirPrefix } from '../pathBasename';

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

describe('parentPath', () => {
  it('returns the posix parent, preserving its separators', () => {
    expect(parentPath('src/utils/x.ts', POSIX)).toBe('src/utils');
  });

  it('returns the native Windows parent, preserving its separators', () => {
    expect(parentPath('src\\utils\\x.ts', WIN)).toBe('src\\utils');
    expect(parentPath('C:\\repo\\src\\x.ts', WIN)).toBe('C:\\repo\\src');
  });

  it('does not split a POSIX name that contains a backslash', () => {
    expect(parentPath('src/weird\\name.ts', POSIX)).toBe('src');
    expect(parentPath('a\\b.md', POSIX)).toBe('');
  });

  it('strips trailing separators before the split (directory input)', () => {
    expect(parentPath('a/b/', POSIX)).toBe('a');
    expect(parentPath('C:\\wt\\src\\', WIN)).toBe('C:\\wt');
  });

  it('returns "" for a root-level file — the loadFiles("") root sentinel', () => {
    expect(parentPath('foo.ts', POSIX)).toBe('');
    expect(parentPath('', POSIX)).toBe('');
    expect(parentPath('/', POSIX)).toBe('');
    expect(parentPath('///', POSIX)).toBe('');
  });

  it('returns the drive root as the parent of a top-level drive entry', () => {
    expect(parentPath('C:\\x', WIN)).toBe('C:');
  });

  it('handles mixed separators', () => {
    expect(parentPath('C:\\repo\\src/utils/x.ts', WIN)).toBe('C:\\repo\\src/utils');
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

describe('round-trip with the FileEditor delete flow', () => {
  it('recomputes the refresh dir for a native-separator path (the fixed bug)', () => {
    // Old code: 'src\\ui\\Button.tsx'.split('/').slice(0, -1).join('/') === ''
    // → reloaded the root and the deleted file lingered in the tree.
    expect(parentPath('src\\ui\\Button.tsx', WIN)).toBe('src\\ui');
    expect(parentPath('src/ui/Button.tsx', POSIX)).toBe('src/ui');
  });
});
