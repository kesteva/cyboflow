/**
 * VerifyDepPreparer tests — the §7.2 prepared-dependency-set builder
 * (docs/proposals/verification-setup-flow.md). PURE module: a real temp
 * worktree + a real temp cache base dir, with the ONE side-effecting seam
 * (`exec`) faked so `cp` becomes an in-process recursive copy and the Electron
 * ABI rebuild becomes a recorded no-op. No pnpm, no Electron, no DB.
 *
 * What is pinned here is the contract the caller depends on: a key that is
 * stable across runs and re-keys on real drift, a clone that degrades from
 * clonefile to a plain copy, the rebuild happening INSIDE the unpublished
 * mirror, publish-by-rename (never a half-built set under the final name),
 * LRU trimming to two sets, single-flighted concurrent builds, and — the
 * property every failure path shares — `null` rather than a throw.
 */
import { describe, it, expect } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import { VerifyDepPreparer, type DepExec } from '../depPreparer';

interface ExecCall {
  cmd: string;
  args: string[];
  cwd: string;
  /** Snapshot of the cache base dir's entries at the moment of the call (publish-ordering evidence). */
  baseEntries: string[];
}

/**
 * The command name the preparer clones with on THIS host (`cp` on POSIX,
 * `robocopy` on win32 — see depPreparer.cloneDir). Assertions that count clone
 * invocations filter on this.
 */
const CLONE_CMD = process.platform === 'win32' ? 'robocopy' : 'cp';

interface FakeExecOptions {
  /** false ⇒ the clone attempt fails, forcing the fallback copy (POSIX `cp -Rc` → `-R`; win32: robocopy exits 8). */
  clonefileSupported?: boolean;
  /** true ⇒ the plain copy fails too (nothing can be cloned). */
  plainCopyFails?: boolean;
  /** Exit code for `npx electron-builder install-app-deps`. */
  rebuildCode?: number;
}

/**
 * A fake exec that actually performs the copy (so the preparer's own existence
 * checks on the published mirror are exercised against real directories) and
 * records every invocation.
 *
 * `clonefileSupported` is a POSIX-only lever: it makes `cp -Rc` fail so the
 * preparer degrades to the plain `-R` copy. On win32 the preparer uses robocopy
 * (no clonefile attempt exists to degrade from), so `clonefileSupported: false`
 * instead forces the robocopy call to fail with a bitmask failure code (8+),
 * and `plainCopyFails` fails the copy outright on both hosts.
 */
function makeFakeExec(
  baseDir: string,
  calls: ExecCall[],
  opts: FakeExecOptions = {},
): DepExec {
  const clonefileSupported = opts.clonefileSupported ?? true;
  return async (cmd, args, execOpts) => {
    let baseEntries: string[] = [];
    try {
      baseEntries = await fsPromises.readdir(baseDir);
    } catch {
      baseEntries = [];
    }
    calls.push({ cmd, args, cwd: execOpts.cwd, baseEntries });

    if (cmd === 'cp') {
      const [flag, src, dest] = args;
      if (flag === '-Rc' && !clonefileSupported) {
        return { code: 1, out: 'cp: illegal option -- c' };
      }
      if (opts.plainCopyFails) return { code: 1, out: 'cp: No space left on device' };
      await fsPromises.cp(src, dest, { recursive: true });
      return { code: 0, out: '' };
    }
    if (cmd === 'robocopy') {
      const [src, dest] = args;
      if (opts.plainCopyFails) return { code: 8, out: 'robocopy: access denied' };
      if (!clonefileSupported) return { code: 8, out: 'robocopy: simulated failure' };
      await fsPromises.cp(src, dest, { recursive: true });
      return { code: 1, out: '' }; // robocopy: 1 = files copied successfully
    }
    if (cmd === 'npx') {
      return { code: opts.rebuildCode ?? 0, out: '' };
    }
    return { code: 127, out: `unexpected command ${cmd}` };
  };
}

interface FixtureOptions {
  lockfileName?: string;
  lockfileBody?: string;
  electron?: string | null;
  /** Extra nested workspace dirs to give a `node_modules` + `package.json`. */
  workspaces?: readonly string[];
}

/** Lays out a worktree with a lockfile, a root package.json, and node_modules dirs. Returns the dep dirs. */
async function makeWorktree(dir: string, opts: FixtureOptions = {}): Promise<string[]> {
  const lockfileName = opts.lockfileName ?? 'pnpm-lock.yaml';
  await fsPromises.writeFile(path.join(dir, lockfileName), opts.lockfileBody ?? 'lockfileVersion: 9\n');
  await fsPromises.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      devDependencies: opts.electron ? { electron: opts.electron } : {},
    }),
  );
  await fsPromises.writeFile(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'sub'\n");

  const depDirs: string[] = [];
  await fsPromises.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fsPromises.writeFile(path.join(dir, 'node_modules', 'marker.txt'), 'root-marker\n');
  depDirs.push(path.join(dir, 'node_modules'));

  for (const ws of opts.workspaces ?? []) {
    await fsPromises.mkdir(path.join(dir, ws, 'node_modules'), { recursive: true });
    await fsPromises.writeFile(path.join(dir, ws, 'node_modules', 'marker.txt'), `${ws}-marker\n`);
    await fsPromises.writeFile(path.join(dir, ws, 'package.json'), JSON.stringify({ name: ws }));
    depDirs.push(path.join(dir, ws, 'node_modules'));
  }
  return depDirs;
}

/** `<baseDir>/<key>/node_modules` → `<key>`. */
function keyOf(mirrorDir: string): string {
  return path.basename(path.dirname(mirrorDir));
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsPromises.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Runs `fn` with a fresh worktree dir and a fresh (non-existent) cache base dir. */
async function withFixture(
  fn: (ctx: { worktree: string; baseDir: string }) => Promise<void>,
): Promise<void> {
  await withTempDir('dep-preparer-', async (root) => {
    const worktree = path.join(root, 'worktree');
    await fsPromises.mkdir(worktree, { recursive: true });
    await fn({ worktree, baseDir: path.join(root, 'verify-deps') });
  });
}

describe('VerifyDepPreparer.prepare — keying', () => {
  it('mirrors each dependency dir at its worktree-relative path and reuses the set on a second call', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree, { workspaces: ['sub'] });
      const calls: ExecCall[] = [];
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, calls) });

      const first = await preparer.prepare(worktree, depDirs);
      expect(first).not.toBeNull();
      const rootMirror = first?.get(depDirs[0]) ?? '';
      const subMirror = first?.get(depDirs[1]) ?? '';
      const key = keyOf(rootMirror);

      // Relative layout preserved (pnpm's relative symlinks depend on it).
      expect(rootMirror).toBe(path.join(baseDir, key, 'node_modules'));
      expect(subMirror).toBe(path.join(baseDir, key, 'sub', 'node_modules'));
      expect(await fsPromises.readFile(path.join(rootMirror, 'marker.txt'), 'utf8')).toBe('root-marker\n');
      expect(await fsPromises.readFile(path.join(subMirror, 'marker.txt'), 'utf8')).toBe('sub-marker\n');

      // Manifests land at their same relative spots.
      expect(await exists(path.join(baseDir, key, 'pnpm-lock.yaml'))).toBe(true);
      expect(await exists(path.join(baseDir, key, 'pnpm-workspace.yaml'))).toBe(true);
      expect(await exists(path.join(baseDir, key, 'package.json'))).toBe(true);
      expect(await exists(path.join(baseDir, key, 'sub', 'package.json'))).toBe(true);

      // REUSE: same key, and no second clone.
      const cloneCalls = calls.filter((c) => c.cmd === CLONE_CMD).length;
      const second = await preparer.prepare(worktree, depDirs);
      expect(second?.get(depDirs[0])).toBe(rootMirror);
      expect(calls.filter((c) => c.cmd === CLONE_CMD).length).toBe(cloneCalls);
    });
  });

  it('re-keys when the lockfile bytes change, leaving the old set addressable', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const calls: ExecCall[] = [];
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, calls) });

      const before = await preparer.prepare(worktree, depDirs);
      const keyBefore = keyOf(before?.get(depDirs[0]) ?? '');

      await fsPromises.writeFile(path.join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# a new dep\n');
      const after = await preparer.prepare(worktree, depDirs);
      const keyAfter = keyOf(after?.get(depDirs[0]) ?? '');

      expect(keyAfter).not.toBe(keyBefore);
      expect(calls.filter((c) => c.cmd === CLONE_CMD).length).toBe(2);
      expect(await exists(path.join(baseDir, keyBefore))).toBe(true);
    });
  });

  it('re-keys when the declared electron version changes (the ABI the mirror was rebuilt for)', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree, { electron: '38.0.0' });
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, []) });

      const before = await preparer.prepare(worktree, depDirs);
      await fsPromises.writeFile(
        path.join(worktree, 'package.json'),
        JSON.stringify({ name: 'fixture', devDependencies: { electron: '39.0.0' } }),
      );
      const after = await preparer.prepare(worktree, depDirs);

      expect(keyOf(after?.get(depDirs[0]) ?? '')).not.toBe(keyOf(before?.get(depDirs[0]) ?? ''));
    });
  });

  it('declines (null) when the worktree root has no lockfile — no stable key to cache on', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      await fsPromises.rm(path.join(worktree, 'pnpm-lock.yaml'));
      const calls: ExecCall[] = [];
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, calls) });

      expect(await preparer.prepare(worktree, depDirs)).toBeNull();
      expect(calls).toEqual([]);
    });
  });

  it('accepts a package-lock.json / yarn.lock project too', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree, { lockfileName: 'yarn.lock', lockfileBody: '# yarn v1\n' });
      await fsPromises.rm(path.join(worktree, 'pnpm-workspace.yaml'));
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, []) });

      const map = await preparer.prepare(worktree, depDirs);
      expect(map).not.toBeNull();
      expect(await exists(path.join(baseDir, keyOf(map?.get(depDirs[0]) ?? ''), 'yarn.lock'))).toBe(true);
    });
  });
});

describe('VerifyDepPreparer.prepare — clone, rebuild, publish', () => {
  // POSIX-only: the clonefile→plain-copy ladder is a `cp -Rc` story. Windows
  // clones with robocopy in ONE call (no clonefile attempt exists to degrade
  // from — see depPreparer.cloneDir), so there is no fallback ladder to pin
  // there; the win32 robocopy happy path is covered by the keying tests above.
  it.skipIf(process.platform === 'win32')(
    'falls back from `cp -Rc` (clonefile) to a plain `cp -R` and still publishes',
    async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const calls: ExecCall[] = [];
      const preparer = new VerifyDepPreparer({
        baseDir,
        exec: makeFakeExec(baseDir, calls, { clonefileSupported: false }),
      });

      const map = await preparer.prepare(worktree, depDirs);

      expect(map).not.toBeNull();
      const cpFlags = calls.filter((c) => c.cmd === CLONE_CMD).map((c) => c.args[0]);
      expect(cpFlags).toEqual(['-Rc', '-R']);
      expect(await fsPromises.readFile(path.join(map?.get(depDirs[0]) ?? '', 'marker.txt'), 'utf8')).toBe(
        'root-marker\n',
      );
    });
  });

  it('runs the Electron ABI rebuild in the UNPUBLISHED mirror root when the project depends on electron', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree, { electron: '^38.0.0' });
      const calls: ExecCall[] = [];
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, calls) });

      const map = await preparer.prepare(worktree, depDirs);
      const key = keyOf(map?.get(depDirs[0]) ?? '');

      const rebuild = calls.find((c) => c.cmd === 'npx');
      expect(rebuild?.args).toEqual(['electron-builder', 'install-app-deps']);
      // In the mirror root, and that root is still the tmp build dir: publish
      // happens strictly AFTER the rebuild (build-then-rename).
      expect(rebuild?.cwd.startsWith(path.join(baseDir, `${key}.tmp-`))).toBe(true);
      expect(rebuild?.baseEntries.some((e) => e === key)).toBe(false);
      expect(rebuild?.baseEntries.every((e) => e.includes('.tmp-'))).toBe(true);

      // Published cleanly: exactly the final key dir, no build leftovers.
      expect(await fsPromises.readdir(baseDir)).toEqual([key]);
    });
  });

  it('skips the rebuild entirely for a project that does not depend on electron', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const calls: ExecCall[] = [];
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, calls) });

      await preparer.prepare(worktree, depDirs);

      expect(calls.some((c) => c.cmd === 'npx')).toBe(false);
    });
  });

  it('single-flights concurrent prepares of the same key onto ONE build', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const calls: ExecCall[] = [];
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, calls) });

      const [a, b, c] = await Promise.all([
        preparer.prepare(worktree, depDirs),
        preparer.prepare(worktree, depDirs),
        preparer.prepare(worktree, depDirs),
      ]);

      expect(calls.filter((call) => call.cmd === CLONE_CMD).length).toBe(1);
      expect(a?.get(depDirs[0])).toBe(b?.get(depDirs[0]));
      expect(b?.get(depDirs[0])).toBe(c?.get(depDirs[0]));

      // The flight registry released: a later prepare still resolves (via reuse).
      expect(await preparer.prepare(worktree, depDirs)).not.toBeNull();
    });
  });

  it('LRU-trims to the two most recently used sets after a publish, deleting only inside baseDir', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, []) });

      const keys: string[] = [];
      for (const [index, body] of ['a\n', 'b\n', 'c\n'].entries()) {
        await fsPromises.writeFile(path.join(worktree, 'pnpm-lock.yaml'), body);
        const map = await preparer.prepare(worktree, depDirs);
        const key = keyOf(map?.get(depDirs[0]) ?? '');
        keys.push(key);
        // Deterministic recency: the just-built set is stamped explicitly so the
        // LRU order cannot depend on three Date.now() calls inside one ms.
        await fsPromises.writeFile(path.join(baseDir, key, '.last-used'), `${1000 + index}`);
      }

      const remaining = (await fsPromises.readdir(baseDir)).sort();
      expect(remaining).toEqual([keys[1], keys[2]].sort());
      // The worktree the sets were cloned from is untouched by GC.
      expect(await exists(path.join(worktree, 'node_modules', 'marker.txt'))).toBe(true);
    });
  });
});

describe('VerifyDepPreparer.prepare — GC grace window', () => {
  it('does not reclaim an older mirror still inside the grace window, even past keep-2', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, []) });
      const now = Date.now();

      await fsPromises.writeFile(path.join(worktree, 'pnpm-lock.yaml'), 'a\n');
      const mapA = await preparer.prepare(worktree, depDirs);
      const keyA = keyOf(mapA?.get(depDirs[0]) ?? '');
      // Ranked oldest of the three below, but still well inside the 15-minute
      // grace window — a hypothetical in-flight clone from it must survive.
      await fsPromises.writeFile(path.join(baseDir, keyA, '.last-used'), `${now - 5 * 60 * 1000}`);

      await fsPromises.writeFile(path.join(worktree, 'pnpm-lock.yaml'), 'b\n');
      const mapB = await preparer.prepare(worktree, depDirs);
      const keyB = keyOf(mapB?.get(depDirs[0]) ?? '');
      await fsPromises.writeFile(path.join(baseDir, keyB, '.last-used'), `${now - 2 * 60 * 1000}`);

      // This 3rd key's publish is what triggers the GC pass (build → publish
      // → gc). Keep-2 alone would rank A oldest and evict it; grace must win.
      await fsPromises.writeFile(path.join(worktree, 'pnpm-lock.yaml'), 'c\n');
      const mapC = await preparer.prepare(worktree, depDirs);
      const keyC = keyOf(mapC?.get(depDirs[0]) ?? '');

      const remaining = (await fsPromises.readdir(baseDir)).sort();
      expect(remaining).toEqual([keyA, keyB, keyC].sort());
    });
  });

  it('reclaims an older mirror once its .last-used stamp is outside the grace window', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, []) });
      const now = Date.now();

      await fsPromises.writeFile(path.join(worktree, 'pnpm-lock.yaml'), 'a\n');
      const mapA = await preparer.prepare(worktree, depDirs);
      const keyA = keyOf(mapA?.get(depDirs[0]) ?? '');
      // Staged past the 15-minute grace window: no fresh clone can plausibly
      // still be reading from this one, so keep-2 ranking applies normally.
      await fsPromises.writeFile(path.join(baseDir, keyA, '.last-used'), `${now - 20 * 60 * 1000}`);

      await fsPromises.writeFile(path.join(worktree, 'pnpm-lock.yaml'), 'b\n');
      const mapB = await preparer.prepare(worktree, depDirs);
      const keyB = keyOf(mapB?.get(depDirs[0]) ?? '');

      await fsPromises.writeFile(path.join(worktree, 'pnpm-lock.yaml'), 'c\n');
      const mapC = await preparer.prepare(worktree, depDirs);
      const keyC = keyOf(mapC?.get(depDirs[0]) ?? '');

      const remaining = (await fsPromises.readdir(baseDir)).sort();
      expect(remaining).toEqual([keyB, keyC].sort());
    });
  });

  it('a reuse touches the .last-used stamp forward, refreshing the grace window', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, []) });

      const first = await preparer.prepare(worktree, depDirs);
      const key = keyOf(first?.get(depDirs[0]) ?? '');
      const stampPath = path.join(baseDir, key, '.last-used');

      // Stage the stamp far in the past so a stale READ (rather than a fresh
      // write) would be visible in the assertion below.
      await fsPromises.writeFile(stampPath, '1000');
      const second = await preparer.prepare(worktree, depDirs);
      expect(second?.get(depDirs[0])).toBe(first?.get(depDirs[0]));

      const stamp = Number(await fsPromises.readFile(stampPath, 'utf8'));
      expect(stamp).toBeGreaterThan(Date.now() - 5000);
    });
  });
});

describe('VerifyDepPreparer.prepare — every failure degrades to null', () => {
  it('no dependency dirs → null, nothing executed', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      await makeWorktree(worktree);
      const calls: ExecCall[] = [];
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, calls) });

      expect(await preparer.prepare(worktree, [])).toBeNull();
      expect(calls).toEqual([]);
    });
  });

  it('a dependency dir outside the run worktree → null (relative layout cannot be preserved)', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const foreign = path.join(path.dirname(worktree), 'elsewhere', 'node_modules');
      await fsPromises.mkdir(foreign, { recursive: true });
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, []) });

      expect(await preparer.prepare(worktree, [...depDirs, foreign])).toBeNull();
    });
  });

  it('a failed clone (both flavors) → null, with no half-built set left behind', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const calls: ExecCall[] = [];
      const preparer = new VerifyDepPreparer({
        baseDir,
        exec: makeFakeExec(baseDir, calls, { clonefileSupported: false, plainCopyFails: true }),
      });

      expect(await preparer.prepare(worktree, depDirs)).toBeNull();
      expect(await fsPromises.readdir(baseDir)).toEqual([]);
    });
  });

  it('a failed Electron rebuild → null, and the failed set is never published', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree, { electron: '38.0.0' });
      const preparer = new VerifyDepPreparer({
        baseDir,
        exec: makeFakeExec(baseDir, [], { rebuildCode: 1 }),
      });

      expect(await preparer.prepare(worktree, depDirs)).toBeNull();
      expect(await fsPromises.readdir(baseDir)).toEqual([]);
    });
  });

  it('a published set missing a requested dir (different layout, same key) → null, never a partial map', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const rootOnly = await makeWorktree(worktree);
      const preparer = new VerifyDepPreparer({ baseDir, exec: makeFakeExec(baseDir, []) });
      expect(await preparer.prepare(worktree, rootOnly)).not.toBeNull();

      // Same lockfile ⇒ same key, but now a nested workspace dir is requested
      // that the published set does not contain.
      await fsPromises.mkdir(path.join(worktree, 'sub', 'node_modules'), { recursive: true });
      const withNested = [...rootOnly, path.join(worktree, 'sub', 'node_modules')];

      expect(await preparer.prepare(worktree, withNested)).toBeNull();
    });
  });

  // The win32 clone arm, driven from any host through the injected platform.
  // Without this the robocopy path is reachable only on a Windows runner, so a
  // macOS CI gives no signal on it at all.
  describe('win32 clone arm', () => {
    it('clones with robocopy and treats a bitmask code below 8 as success', async () => {
      await withFixture(async ({ worktree, baseDir }) => {
        const depDirs = await makeWorktree(worktree);
        const calls: ExecCall[] = [];
        const preparer = new VerifyDepPreparer({
          baseDir,
          platform: 'win32',
          exec: makeFakeExec(baseDir, calls),
        });

        expect(await preparer.prepare(worktree, depDirs)).not.toBeNull();

        const clone = calls.find((c) => c.cmd === 'robocopy');
        expect(clone).toBeDefined();
        // /E recurses including empty dirs; the rest silence the per-file log,
        // which robocopy prints by default and which nothing here reads.
        expect(clone?.args.slice(2)).toEqual(['/E', '/NFL', '/NDL', '/NJH', '/NP', '/NS', '/NC']);
        // Never the POSIX command: cp does not exist on Windows.
        expect(calls.some((c) => c.cmd === 'cp')).toBe(false);
      });
    });

    it('the POSIX arm is equally reachable from a Windows host', async () => {
      // The mirror image of the case above, and what proves the seam drives
      // the branch rather than the host doing so: this runs on Windows and
      // must still take the cp path.
      await withFixture(async ({ worktree, baseDir }) => {
        const depDirs = await makeWorktree(worktree);
        const calls: ExecCall[] = [];
        const preparer = new VerifyDepPreparer({
          baseDir,
          platform: 'darwin',
          exec: makeFakeExec(baseDir, calls),
        });

        expect(await preparer.prepare(worktree, depDirs)).not.toBeNull();
        expect(calls.some((c) => c.cmd === 'cp' && c.args[0] === '-Rc')).toBe(true);
        expect(calls.some((c) => c.cmd === 'robocopy')).toBe(false);
      });
    });

    it('treats a robocopy code of 8 or more as a real failure', async () => {
      await withFixture(async ({ worktree, baseDir }) => {
        const depDirs = await makeWorktree(worktree);
        const preparer = new VerifyDepPreparer({
          baseDir,
          platform: 'win32',
          exec: makeFakeExec(baseDir, [], { plainCopyFails: true }),
        });

        // A failed clone is fail-soft by contract: null, never a throw.
        await expect(preparer.prepare(worktree, depDirs)).resolves.toBeNull();
      });
    });
  });

  it('an exec seam that throws → null rather than propagating', async () => {
    await withFixture(async ({ worktree, baseDir }) => {
      const depDirs = await makeWorktree(worktree);
      const preparer = new VerifyDepPreparer({
        baseDir,
        exec: async () => {
          throw new Error('spawn ENOENT');
        },
      });

      await expect(preparer.prepare(worktree, depDirs)).resolves.toBeNull();
    });
  });
});
