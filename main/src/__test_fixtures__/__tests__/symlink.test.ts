import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirSymlink } from '../symlink';

describe('createDirSymlink', () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'symlink-fixture-'));
    dirs.push(dir);
    return dir;
  };

  it('resolves realpath through the link to the target', () => {
    const root = tmp();
    const real = join(root, 'real');
    const link = join(root, 'link');
    mkdirSync(real);
    writeFileSync(join(real, 'f.txt'), 'x');
    createDirSymlink(real, link);
    expect(realpathSync(join(link, 'f.txt'))).toBe(realpathSync(join(real, 'f.txt')));
    expect(readFileSync(join(link, 'f.txt'), 'utf8')).toBe('x');
  });

  it('lstat reports the link itself as a symbolic link', () => {
    const root = tmp();
    const real = join(root, 'real');
    const link = join(root, 'link');
    mkdirSync(real);
    createDirSymlink(real, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('accepts a dangling target (no validation at creation)', () => {
    const root = tmp();
    const link = join(root, 'dangling');
    createDirSymlink(join(root, 'does-not-exist'), link);
    expect(existsSync(link)).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
});
