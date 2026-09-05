/**
 * peekabooExecutablePath — where the bundled capture binary is found.
 *
 * The rule under test throughout: NEVER return an absolute path that does not
 * exist. A confidently-wrong path makes the grant probe report "binary
 * missing" while a working peekaboo sits on PATH, which is the failure mode
 * that motivated bundling in the first place — a stable binary path is the
 * whole point, and a stale one is worse than none.
 */
import { describe, it, expect, vi } from 'vitest';
import * as nodePath from 'node:path';
import {
  PEEKABOO_PACKAGE,
  PEEKABOO_PATH_FALLBACK,
  resolvePeekabooExecutable,
} from '../peekabooExecutablePath';

const PACKAGED = '/Applications/Cyboflow.app/Contents/Resources';
// Built with path.join — the resolver joins its segments the same way, so the
// separators in the expected value match whatever the host platform emits.
const PACKAGED_BINARY = nodePath.join(
  PACKAGED,
  'app.asar.unpacked',
  'node_modules',
  PEEKABOO_PACKAGE,
  'peekaboo',
);

/** A resolver that never finds the package in node_modules (the packaged case). */
const noPackage = (): string => {
  throw new Error('MODULE_NOT_FOUND');
};

describe('resolvePeekabooExecutable', () => {
  it('prefers the copy unpacked beside the asar in a packaged app', () => {
    // The binary CANNOT be executed from inside the asar archive — `asarUnpack`
    // in package.json is what puts it here.
    const path = resolvePeekabooExecutable({
      isPackaged: true,
      resourcesPath: PACKAGED,
      platform: 'darwin',
      existsSync: (p) => p === PACKAGED_BINARY,
      resolvePackageJson: noPackage,
    });
    expect(path).toBe(PACKAGED_BINARY);
  });

  it('resolves through node_modules in a dev build', () => {
    // pnpm's symlinked layout makes a hand-written relative path wrong, so this
    // goes through the module graph.
    const packageJson = '/repo/node_modules/@steipete/peekaboo-mcp/package.json';
    const resolved = resolvePeekabooExecutable({
      isPackaged: false,
      platform: 'darwin',
      existsSync: () => true,
      resolvePackageJson: () => packageJson,
    });
    expect(resolved).toBe(nodePath.join(nodePath.dirname(packageJson), 'peekaboo'));
  });

  it('falls back to PATH when the bundled copy is NOT on disk', () => {
    // A broken bundle degrades to the pre-bundling behaviour rather than to
    // nothing — a user who already had peekaboo installed keeps working.
    const path = resolvePeekabooExecutable({
      isPackaged: true,
      resourcesPath: PACKAGED,
      platform: 'darwin',
      existsSync: () => false,
      resolvePackageJson: noPackage,
    });
    expect(path).toBe(PEEKABOO_PATH_FALLBACK);
  });

  it('falls back to PATH when the optional dependency was never installed', () => {
    const path = resolvePeekabooExecutable({
      isPackaged: false,
      platform: 'darwin',
      existsSync: () => true,
      resolvePackageJson: noPackage,
    });
    expect(path).toBe(PEEKABOO_PATH_FALLBACK);
  });

  it('never probes for a bundle off macOS', () => {
    // The package declares os: ["darwin"], which is why it is an OPTIONAL
    // dependency — a required one would fail `pnpm install` on the Linux CI
    // runners, where there is simply nothing bundled to find.
    const existsSync = vi.fn().mockReturnValue(true);
    for (const platform of ['linux', 'win32'] as const) {
      expect(
        resolvePeekabooExecutable({
          isPackaged: true,
          resourcesPath: PACKAGED,
          platform,
          existsSync,
          resolvePackageJson: () => '/repo/node_modules/@steipete/peekaboo-mcp/package.json',
        }),
      ).toBe(PEEKABOO_PATH_FALLBACK);
    }
    expect(existsSync).not.toHaveBeenCalled();
  });

  it('skips a candidate whose existence check THROWS rather than propagating', () => {
    // An unreadable candidate is not the one; a throw here would take down the
    // whole backend at construction.
    const devPackageJson = '/repo/node_modules/@steipete/peekaboo-mcp/package.json';
    const resolved = resolvePeekabooExecutable({
      isPackaged: true,
      resourcesPath: PACKAGED,
      platform: 'darwin',
      existsSync: (p) => {
        if (p === PACKAGED_BINARY) throw new Error('EACCES');
        return true;
      },
      resolvePackageJson: () => devPackageJson,
    });
    expect(resolved).toBe(nodePath.join(nodePath.dirname(devPackageJson), 'peekaboo'));
  });

  it('ignores the packaged candidate when resourcesPath is unavailable', () => {
    const devPackageJson = '/repo/node_modules/@steipete/peekaboo-mcp/package.json';
    const resolved = resolvePeekabooExecutable({
      isPackaged: true,
      platform: 'darwin',
      existsSync: () => true,
      resolvePackageJson: () => devPackageJson,
    });
    expect(resolved).toBe(nodePath.join(nodePath.dirname(devPackageJson), 'peekaboo'));
  });
});
