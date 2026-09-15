/**
 * harnessEnv tests (F3 / RC4) — the PATH + NODE_PATH the verification harness
 * exports. Both seams are injected, so this suite spawns no login shell and
 * touches no filesystem: `resolveShellPath` is a thunk and the node_modules walk
 * runs against a fake existence probe.
 */
import { describe, expect, it } from 'vitest';
import { delimiter, join } from 'node:path';
import {
  pathEnvKey,
  prependNodeDir,
  resolveHarnessNodePath,
  resolveHarnessPath,
} from '../harnessEnv';

const SHELL_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);

describe('resolveHarnessPath', () => {
  it('prepends the resolved node directory to the login-shell PATH', async () => {
    const value = await resolveHarnessPath({
      nodeExecutable: '/Users/dev/.nvm/versions/node/v22.14.0/bin/node',
      resolveShellPath: async () => SHELL_PATH,
    });
    expect(value.split(delimiter)[0]).toBe('/Users/dev/.nvm/versions/node/v22.14.0/bin');
    expect(value.endsWith(SHELL_PATH)).toBe(true);
  });

  it('does not duplicate a node directory the shell already exports', async () => {
    const value = await resolveHarnessPath({
      nodeExecutable: '/usr/local/bin/node',
      resolveShellPath: async () => SHELL_PATH,
    });
    expect(value).toBe(SHELL_PATH);
  });

  it('uses the login-shell PATH verbatim when no node was resolved', async () => {
    // depPreparer's shape: it resolves no node of its own, and the login-shell
    // PATH is the whole point there (it is where `npx` lives).
    const value = await resolveHarnessPath({ resolveShellPath: async () => SHELL_PATH });
    expect(value).toBe(SHELL_PATH);
  });

  // The worst case of this fix must be TODAY's behavior, never a new failure.
  it('degrades to the fallback PATH when the shell lookup throws', async () => {
    const value = await resolveHarnessPath({
      nodeExecutable: '/opt/node/bin/node',
      resolveShellPath: async () => {
        throw new Error('login shell unavailable');
      },
      // Joined with the host delimiter: prependNodeDir splits on it, so a
      // hardcoded ':' is ONE opaque entry on Windows and the assertion drifts.
      fallbackPath: ['/usr/bin', '/bin'].join(delimiter),
    });
    expect(value).toBe(['/opt/node/bin', '/usr/bin', '/bin'].join(delimiter));
  });

  it('degrades to the fallback PATH when the shell answers empty', async () => {
    const value = await resolveHarnessPath({
      resolveShellPath: async () => '   ',
      fallbackPath: '/usr/bin:/bin',
    });
    expect(value).toBe('/usr/bin:/bin');
  });
});

describe('prependNodeDir', () => {
  it('is a no-op for a bare command name (dirname is ".", which never goes on PATH)', () => {
    expect(prependNodeDir(SHELL_PATH, 'node')).toBe(SHELL_PATH);
  });

  it('is a no-op when no node executable is known', () => {
    expect(prependNodeDir(SHELL_PATH, null)).toBe(SHELL_PATH);
  });
});

describe('resolveHarnessNodePath', () => {
  /** A fake tree: only these absolute paths exist. */
  const world = (present: string[]) => async (p: string) => present.includes(p);

  it("walks up to CYBOFLOW's own node_modules (the dev repo root)", async () => {
    const repo = '/repo';
    const driverCli = join(repo, 'main/dist/orchestrator/verify/driver/driverCli.js');
    const found = await resolveHarnessNodePath(
      driverCli,
      world([join(repo, 'node_modules/playwright/package.json')]),
    );
    expect(found).toBe(join(repo, 'node_modules'));
  });

  it('stops at the NEAREST directory carrying playwright', async () => {
    // Spelled through `join` like the sibling case: the walk probes
    // `join(dir, marker)`, which is backslash-separated on Windows, so a fake
    // tree keyed on POSIX literals is never hit there.
    const repo = '/repo';
    const driverCli = join(repo, 'main/dist/driver/driverCli.js');
    const found = await resolveHarnessNodePath(
      driverCli,
      world([
        join(repo, 'main/node_modules/playwright/package.json'),
        join(repo, 'node_modules/playwright/package.json'),
      ]),
    );
    expect(found).toBe(join(repo, 'main/node_modules'));
  });

  // The packaged shape: asarUnpack unpacks the driver JS AND node_modules/
  // playwright*, so the walk from the unpacked driver reaches the unpacked
  // node_modules (smoked against a real arm64 build, 9/10).
  const UNPACKED = join('/Applications/Cyboflow.app/Contents/Resources', 'app.asar.unpacked');

  it('finds the unpacked node_modules in a packaged app', async () => {
    // Spelled through `join` like the sibling cases: the walk probes
    // `join(dir, marker)`, which is backslash-separated on Windows, so a fake
    // tree keyed on POSIX literals is never hit there.
    const found = await resolveHarnessNodePath(
      join(UNPACKED, 'main/dist/driver/driverCli.js'),
      world([join(UNPACKED, 'node_modules/playwright/package.json')]),
    );
    expect(found).toBe(join(UNPACKED, 'node_modules'));
  });

  // A packaged build whose asarUnpack lost the playwright entries: the marker
  // is nowhere on the walk (inside app.asar is unreadable to plain node), and
  // an absent NODE_PATH is the honest answer — see the function's doc.
  it('answers null when no node_modules on the walk carries playwright', async () => {
    const found = await resolveHarnessNodePath(
      join(UNPACKED, 'main/dist/driver/driverCli.js'),
      // Present, but off the walk. Spelled through `join` so this stays a real
      // negative on Windows rather than passing because nothing can match.
      world([join('/somewhere/else', 'node_modules/playwright/package.json')]),
    );
    expect(found).toBeNull();
  });

  // A node_modules WITHOUT playwright is not the driver's runtime: answering it
  // would set NODE_PATH to a directory the `require('playwright')` cannot use,
  // whose MODULE_NOT_FOUND the driver masks as "CDP endpoint not reachable".
  it('ignores a node_modules that does not carry playwright', async () => {
    const found = await resolveHarnessNodePath('/repo/main/dist/driverCli.js', world([]));
    expect(found).toBeNull();
  });

  it('terminates at the filesystem root rather than looping', async () => {
    await expect(resolveHarnessNodePath('/driverCli.js', world([]))).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pathEnvKey (round-2 review)
//
// Windows env names are case-insensitive to the OS but Node reports their
// ORIGINAL case (`Path`). A hardcoded `PATH` key does not collide with that on
// an object spread, so the merged env carries BOTH and which one CreateProcess
// hands the child is undefined. Driven through explicit base maps so both
// platforms' shapes pin on any host.
// ---------------------------------------------------------------------------

describe('pathEnvKey', () => {
  it("answers the Windows spelling when that is what the process carries", () => {
    expect(pathEnvKey({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' })).toBe('Path');
  });

  it('answers the POSIX spelling unchanged', () => {
    expect(pathEnvKey({ PATH: '/usr/bin:/bin' })).toBe('PATH');
  });

  it('falls back to PATH when the process carries none', () => {
    expect(pathEnvKey({})).toBe('PATH');
  });

  it('matches on case alone, never on a name that merely contains "path"', () => {
    expect(pathEnvKey({ NODE_PATH: '/n', PYTHONPATH: '/p' })).toBe('PATH');
  });
});
