/**
 * snapshotProvisioner tests — run against a REAL throwaway git repo fixture
 * (no DB, no Electron). Covers captureSnapshotSha, provisionSnapshot's
 * exact-sha checkout + node_modules CLONING, the §7.2 prepared-dependency
 * mirror seam (clone from the mirror when a set exists, from the live worktree
 * when it does not) and its kill switch, the typed bad-sha error, and dispose's
 * unconditional/idempotent teardown.
 *
 * THE CLONE IS THE SUBJECT, SO THE CLONE IS REAL. Every dependency case below
 * runs the REAL `cp` binary — for the snapshot (whose `exec` is left at its
 * production default) and for the preparer's mirror (whose fake exec delegates
 * `cp` to `defaultDepExec`). That is not incidental. `fsPromises.cp` REWRITES a
 * relative symlink into an absolute path pointing back at the SOURCE tree, so a
 * fixture built with it would hand the workspace-link case a link that resolves
 * into the live worktree — i.e. it would silently reproduce the exact bug these
 * tests exist to prove is gone, and pass. `-c` (clonefile) may or may not be
 * available on the temp filesystem; the module's `-R` fallback covers that and
 * the observable end state is identical either way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import {
  captureSnapshotSha,
  isRunbookCommittedAtHead,
  provisionSnapshot,
  findDependencyDirs,
  resolveDefaultDepPreparer,
  SnapshotProvisionError,
} from '../snapshotProvisioner';
import { VerifyDepPreparer, defaultDepExec, type DepExec } from '../depPreparer';
import { VERIFY_RUNBOOK_RELATIVE_PATH } from '../../../../../shared/types/verifyRunbook';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * An exec seam for VerifyDepPreparer that performs the CLONE RUNGS for real —
 * `cp` on POSIX (see the file header — a JS-level copy would rewrite relative
 * symlinks and invalidate the workspace-link case), robocopy on Windows — both
 * via the production `defaultDepExec` — and treats the Electron rebuild as a
 * no-op: the preparer's own suite proves its mechanics, and here it only has
 * to produce a real mirror on disk for the snapshot to clone from.
 */
function realCloneDepExec(): DepExec {
  return async (cmd, args, opts) =>
    cmd === 'cp' || cmd === 'robocopy' ? defaultDepExec(cmd, args, opts) : { code: 0, out: '' };
}

/** Adds the lockfile + package.json the preparer keys on (uncommitted is fine — it reads the live worktree). */
async function addPreparerInputs(dir: string): Promise<void> {
  await fsPromises.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await fsPromises.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }));
}

/** Initializes a fixture repo with an initial commit, config'd for CI commits. */
async function initFixtureRepo(dir: string): Promise<void> {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@cyboflow.dev']);
  git(dir, ['config', 'user.name', 'Cyboflow Test']);
  // The fixtures assert exact file bytes ('v1\n'); a host with core.autocrlf=true
  // would CRLF-convert the snapshot's checkout and break every byte comparison.
  git(dir, ['config', 'core.autocrlf', 'false']);
  await fsPromises.writeFile(path.join(dir, 'README.md'), 'v1\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

/** The single published prepared set under `baseDir` (the fixtures only ever build one). */
async function soleMirrorRoot(baseDir: string): Promise<string> {
  const entries = await fsPromises.readdir(baseDir);
  expect(entries).toHaveLength(1);
  return path.join(baseDir, entries[0]);
}

/** Whether a path exists at all (a dangling symlink counts as existing — `lstat`, not `stat`). */
async function exists(target: string): Promise<boolean> {
  try {
    await fsPromises.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * HERMETICITY: with no explicit `depPreparer`, provisionSnapshot resolves the
 * DEFAULT preparer, whose cache lives under `CYBOFLOW_DIR|~/.cyboflow`. A unit
 * test must never build a prepared set in the user's real data dir, so the §7.2
 * kill switch is on for every test in this file. The cases that DO exercise the
 * preparer inject their own (an explicit `depPreparer` bypasses the switch), and
 * the kill-switch test manages the variable itself.
 */
beforeEach(() => {
  process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER = '1';
});
afterEach(() => {
  delete process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER;
});

describe('snapshotProvisioner', () => {
  describe('captureSnapshotSha', () => {
    it('returns HEAD of the run worktree', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        const expected = git(dir, ['rev-parse', 'HEAD']).trim();

        const sha = await captureSnapshotSha(dir);

        expect(sha).toBe(expected);
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });

  // The `.cyboflow/` exclude collision (live dogfood 2026-07-31): many repos
  // ignore or locally-exclude `.cyboflow/`, so `git add` on the runbook path is
  // a no-op that reports success, the registration reads the working tree
  // happily, and the proof then builds a snapshot with no runbook in it.
  describe('isRunbookCommittedAtHead', () => {
    it('is true when the runbook is present at HEAD', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        await fsPromises.mkdir(path.join(dir, '.cyboflow'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, VERIFY_RUNBOOK_RELATIVE_PATH), '{"version":1}');
        git(dir, ['add', '-f', VERIFY_RUNBOOK_RELATIVE_PATH]);
        git(dir, ['commit', '-q', '-m', 'add runbook']);

        expect(await isRunbookCommittedAtHead(dir, VERIFY_RUNBOOK_RELATIVE_PATH)).toBe(true);
      });
    });

    it('is false for a runbook written but never committed (the excluded-path case)', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        // Exactly the observed condition: the path is excluded, so `git add`
        // succeeds while staging nothing at all.
        await fsPromises.appendFile(path.join(dir, '.git', 'info', 'exclude'), '\n.cyboflow/\n');
        await fsPromises.mkdir(path.join(dir, '.cyboflow'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, VERIFY_RUNBOOK_RELATIVE_PATH), '{"version":1}');
        git(dir, ['add', '.']);
        git(dir, ['commit', '-q', '--allow-empty', '-m', 'add runbook (or so it looked)']);

        expect(await isRunbookCommittedAtHead(dir, VERIFY_RUNBOOK_RELATIVE_PATH)).toBe(false);
      });
    });

    it('fails soft to false outside a git repo', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        expect(await isRunbookCommittedAtHead(dir, VERIFY_RUNBOOK_RELATIVE_PATH)).toBe(false);
      });
    });
  });

  describe('provisionSnapshot', () => {
    it('checks out the exact recorded sha, not a later commit', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        const snapshotSha = await captureSnapshotSha(dir);

        // A later commit changes the file's content in the run worktree.
        await fsPromises.writeFile(path.join(dir, 'README.md'), 'v2 (later commit)\n');
        git(dir, ['add', '.']);
        git(dir, ['commit', '-q', '-m', 'later commit']);

        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });
        try {
          expect(provision.sha).toBe(snapshotSha);
          const content = await fsPromises.readFile(path.join(provision.worktreePath, 'README.md'), 'utf8');
          expect(content).toBe('v1\n');
        } finally {
          await provision.dispose();
        }
      });
    });

    it('a dirty run worktree (concurrent-lane edits) still snapshots the recorded sha cleanly', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        const snapshotSha = await captureSnapshotSha(dir);

        // Simulate sibling lanes mid-edit in the shared worktree: an uncommitted
        // tracked change AND an untracked file. Neither may leak into the snapshot.
        await fsPromises.writeFile(path.join(dir, 'README.md'), 'sibling lane mid-edit\n');
        await fsPromises.writeFile(path.join(dir, 'sibling-untracked.ts'), 'wip\n');

        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });
        try {
          expect(provision.sha).toBe(snapshotSha);
          const content = await fsPromises.readFile(path.join(provision.worktreePath, 'README.md'), 'utf8');
          expect(content).toBe('v1\n');
          await expect(
            fsPromises.access(path.join(provision.worktreePath, 'sibling-untracked.ts')),
          ).rejects.toThrow();
        } finally {
          await provision.dispose();
        }
      });
    });

    it('CLONES node_modules dirs (root + nested) into the snapshot, skips scanning inside one, and a snapshot write never reaches the worktree', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);

        // Root-level node_modules with a marker file.
        await fsPromises.mkdir(path.join(dir, 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'node_modules', 'marker.txt'), 'root-marker\n');

        // A nested workspace node_modules.
        await fsPromises.mkdir(path.join(dir, 'sub', 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'sub', 'node_modules', 'marker.txt'), 'sub-marker\n');
        // `sub` itself must exist in the snapshot's checked-out tree for the
        // clone to land — track it via a placeholder file and commit.
        await fsPromises.writeFile(path.join(dir, 'sub', 'keep.txt'), 'keep\n');
        git(dir, ['add', 'sub/keep.txt']);
        git(dir, ['commit', '-q', '-m', 'add sub dir']);

        // node_modules-inside-node_modules: must never be scanned as an
        // independent top-level dependency dir.
        await fsPromises.mkdir(path.join(dir, 'node_modules', 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'node_modules', 'node_modules', 'inner.txt'), 'inner\n');

        const found = await findDependencyDirs(dir);
        const relFound = found.map((f) => path.relative(dir, f)).sort();
        expect(relFound).toEqual(['node_modules', path.join('sub', 'node_modules')].sort());
        expect(relFound).not.toContain(path.join('node_modules', 'node_modules'));

        const snapshotSha = await captureSnapshotSha(dir);
        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });
        try {
          const rootDep = path.join(provision.worktreePath, 'node_modules');
          const subDep = path.join(provision.worktreePath, 'sub', 'node_modules');

          expect(await fsPromises.readFile(path.join(rootDep, 'marker.txt'), 'utf8')).toBe('root-marker\n');
          expect(await fsPromises.readFile(path.join(subDep, 'marker.txt'), 'utf8')).toBe('sub-marker\n');

          // The §7.2 fix in one assertion pair: these are the snapshot's OWN
          // directories, not aliases of the shared worktree's.
          const rootStat = await fsPromises.lstat(rootDep);
          expect(rootStat.isSymbolicLink()).toBe(false);
          expect(rootStat.isDirectory()).toBe(true);
          const subStat = await fsPromises.lstat(subDep);
          expect(subStat.isSymbolicLink()).toBe(false);
          expect(subStat.isDirectory()).toBe(true);

          // …so a write inside the snapshot (an install, a hand-edited module, a
          // build artifact) cannot reach the tree sibling lanes are building in.
          await fsPromises.writeFile(path.join(rootDep, 'written-by-verification.txt'), 'x\n');
          await fsPromises.writeFile(path.join(subDep, 'written-by-verification.txt'), 'x\n');
          expect(await exists(path.join(dir, 'node_modules', 'written-by-verification.txt'))).toBe(false);
          expect(await exists(path.join(dir, 'sub', 'node_modules', 'written-by-verification.txt'))).toBe(false);
        } finally {
          await provision.dispose();
        }
      });
    });

    // POSIX-only fixture, deliberately: the subject is a RELATIVE workspace
    // symlink preserved verbatim through both copies. Windows cannot create one
    // without symlink privilege (EPERM), and its junction equivalent is
    // absolute-only, so there is no relative workspace link there to preserve.
    it.skipIf(process.platform === 'win32')(
      'a pnpm WORKSPACE link inside a cloned mirror resolves against the SNAPSHOT source — not the live worktree, not the mirror (§7.2 finding 6)',
      async () => {
        await withTempDir('snapshot-provisioner-', async (dir) => {
          const worktree = path.join(dir, 'worktree');
          await fsPromises.mkdir(worktree, { recursive: true });
          await initFixtureRepo(worktree);
          await addPreparerInputs(worktree);

          // The workspace shape that broke: `frontend` depends on the local
          // `shared` package, and pnpm expresses that as a RELATIVE symlink out of
          // node_modules into WORKSPACE SOURCE — not into the `.pnpm` store.
          await fsPromises.mkdir(path.join(worktree, 'shared'), { recursive: true });
          await fsPromises.writeFile(path.join(worktree, 'shared', 'mod.js'), 'committed at the snapshot sha\n');
          await fsPromises.mkdir(path.join(worktree, 'frontend'), { recursive: true });
          await fsPromises.writeFile(path.join(worktree, 'frontend', 'package.json'), JSON.stringify({ name: 'fe' }));
          git(worktree, ['add', 'shared/mod.js', 'frontend/package.json']);
          git(worktree, ['commit', '-q', '-m', 'workspace source']);
          const snapshotSha = await captureSnapshotSha(worktree);

          await fsPromises.mkdir(path.join(worktree, 'frontend', 'node_modules'), { recursive: true });
          await fsPromises.symlink('../../shared', path.join(worktree, 'frontend', 'node_modules', 'shared'), 'dir');
          await fsPromises.mkdir(path.join(worktree, 'node_modules'), { recursive: true });

          // A sibling lane edits the workspace source AFTER the recorded sha. If
          // the link resolved into the live worktree we would read this string;
          // reading the committed one is the proof it resolved into the snapshot.
          await fsPromises.writeFile(path.join(worktree, 'shared', 'mod.js'), 'uncommitted sibling-lane edit\n');

          const baseDir = path.join(dir, 'verify-deps');
          const depPreparer = new VerifyDepPreparer({ baseDir, exec: realCloneDepExec() });

          const provision = await provisionSnapshot({ runWorktreePath: worktree, snapshotSha, depPreparer });
          try {
            const linkPath = path.join(provision.worktreePath, 'frontend', 'node_modules', 'shared');

            // The link survived both copies VERBATIM — dereferencing it anywhere
            // along the way would have re-pinned the snapshot to foreign source.
            expect((await fsPromises.lstat(linkPath)).isSymbolicLink()).toBe(true);
            expect(await fsPromises.readlink(linkPath)).toBe('../../shared');

            // …and it resolves to the SNAPSHOT's checked-out `shared/`.
            expect(await fsPromises.realpath(linkPath)).toBe(
              await fsPromises.realpath(path.join(provision.worktreePath, 'shared')),
            );
            expect(await fsPromises.readFile(path.join(linkPath, 'mod.js'), 'utf8')).toBe(
              'committed at the snapshot sha\n',
            );

            // The mirror could never have satisfied this link: it holds
            // dependencies and deliberately no source, so `<mirror>/shared` does
            // not exist. That is finding 6 stated as a fixture fact — before the
            // clone, this link pointed here and dangled.
            expect(await exists(path.join(await soleMirrorRoot(baseDir), 'shared'))).toBe(false);
          } finally {
            await provision.dispose();
          }
        });
      },
    );

    it('clones from the PREPARED MIRROR when a prepared set exists (§7.2), and snapshot writes reach neither the mirror nor the worktree', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        const worktree = path.join(dir, 'worktree');
        await fsPromises.mkdir(worktree, { recursive: true });
        await initFixtureRepo(worktree);
        await addPreparerInputs(worktree);
        await fsPromises.mkdir(path.join(worktree, 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(worktree, 'node_modules', 'marker.txt'), 'live-marker\n');

        const baseDir = path.join(dir, 'verify-deps');
        const depPreparer = new VerifyDepPreparer({ baseDir, exec: realCloneDepExec() });
        const snapshotSha = await captureSnapshotSha(worktree);

        const provision = await provisionSnapshot({ runWorktreePath: worktree, snapshotSha, depPreparer });
        try {
          const depDir = path.join(provision.worktreePath, 'node_modules');
          const mirrorRoot = await soleMirrorRoot(baseDir);

          // A prepared set really was built and really was the source: the
          // snapshot's tree carries the mirror's contents…
          expect(await exists(path.join(mirrorRoot, 'node_modules', 'marker.txt'))).toBe(true);
          expect(await fsPromises.readFile(path.join(depDir, 'marker.txt'), 'utf8')).toBe('live-marker\n');

          // …as its OWN directory. Nothing in the snapshot references the cache
          // or the worktree, which is what makes the write below terminal.
          expect((await fsPromises.lstat(depDir)).isSymbolicLink()).toBe(false);

          await fsPromises.writeFile(path.join(depDir, 'written-by-verification.txt'), 'x\n');
          expect(await exists(path.join(mirrorRoot, 'node_modules', 'written-by-verification.txt'))).toBe(false);
          expect(await exists(path.join(worktree, 'node_modules', 'written-by-verification.txt'))).toBe(false);
        } finally {
          await provision.dispose();
        }
      });
    });

    it('clones from the LIVE worktree dirs when the preparer declines (no prepared set) — cold, still isolated', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        const worktree = path.join(dir, 'worktree');
        await fsPromises.mkdir(worktree, { recursive: true });
        await initFixtureRepo(worktree);
        // No lockfile ⇒ the preparer has no stable key and returns null.
        await fsPromises.mkdir(path.join(worktree, 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(worktree, 'node_modules', 'marker.txt'), 'live-marker\n');

        const baseDir = path.join(dir, 'verify-deps');
        const depPreparer = new VerifyDepPreparer({ baseDir, exec: realCloneDepExec() });
        const snapshotSha = await captureSnapshotSha(worktree);

        const provision = await provisionSnapshot({ runWorktreePath: worktree, snapshotSha, depPreparer });
        try {
          const depDir = path.join(provision.worktreePath, 'node_modules');
          expect(await fsPromises.readFile(path.join(depDir, 'marker.txt'), 'utf8')).toBe('live-marker\n');
          expect((await fsPromises.lstat(depDir)).isSymbolicLink()).toBe(false);
          // Nothing was cached — the fallback is a direct live→snapshot clone.
          expect(await exists(baseDir)).toBe(false);

          // The no-mirror path is the one the old symlink hazard lived on, so
          // this is the assertion that matters most: a write still stops here.
          await fsPromises.writeFile(path.join(depDir, 'written-by-verification.txt'), 'x\n');
          expect(await exists(path.join(worktree, 'node_modules', 'written-by-verification.txt'))).toBe(false);
        } finally {
          await provision.dispose();
        }
      });
    });

    it('depPreparer: null (the §7.2 kill switch) still clones into the snapshot — no mirror, no re-opened write-through', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        const worktree = path.join(dir, 'worktree');
        await fsPromises.mkdir(worktree, { recursive: true });
        await initFixtureRepo(worktree);
        await addPreparerInputs(worktree);
        await fsPromises.mkdir(path.join(worktree, 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(worktree, 'node_modules', 'marker.txt'), 'live-marker\n');

        const snapshotSha = await captureSnapshotSha(worktree);
        const provision = await provisionSnapshot({ runWorktreePath: worktree, snapshotSha, depPreparer: null });
        try {
          const depDir = path.join(provision.worktreePath, 'node_modules');
          expect(await fsPromises.readFile(path.join(depDir, 'marker.txt'), 'utf8')).toBe('live-marker\n');
          expect((await fsPromises.lstat(depDir)).isSymbolicLink()).toBe(false);

          await fsPromises.writeFile(path.join(depDir, 'written-by-verification.txt'), 'x\n');
          expect(await exists(path.join(worktree, 'node_modules', 'written-by-verification.txt'))).toBe(false);
        } finally {
          await provision.dispose();
        }
      });
    });

    it('a failed clone is SKIPPED, not thrown: the snapshot provisions without that dep dir rather than falling back to a link', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        await fsPromises.mkdir(path.join(dir, 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'node_modules', 'marker.txt'), 'live-marker\n');
        const snapshotSha = await captureSnapshotSha(dir);

        // Both rungs of the ladder fail — a full disk, a permissions problem, a
        // filesystem that refuses the copy outright.
        const cpArgs: string[][] = [];
        const provision = await provisionSnapshot({
          runWorktreePath: dir,
          snapshotSha,
          exec: async (cmd, args) => {
            cpArgs.push([cmd, ...args]);
            return { code: 1, out: 'cp: no space left on device' };
          },
        });
        try {
          // It tried clonefile first, then the plain recursive copy — on every
          // platform. The production default TRANSLATES these rungs on Windows
          // (no `cp` binary there), but an injected exec is the seam itself and
          // is consulted verbatim on both.
          expect(cpArgs.map((a) => a[1])).toEqual(['-Rc', '-R']);
          // …and then left the dir absent, which surfaces downstream as an
          // honest build failure. A symlink here would be the §7.2 hazard
          // re-opened for exactly the case least able to notice it.
          expect(await exists(path.join(provision.worktreePath, 'node_modules'))).toBe(false);
        } finally {
          await provision.dispose();
        }
      });
    });

    it('throws a typed SnapshotProvisionError for a sha that does not resolve', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);

        await expect(
          provisionSnapshot({ runWorktreePath: dir, snapshotSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
        ).rejects.toMatchObject({ name: 'SnapshotProvisionError', code: 'bad_sha' });

        try {
          await provisionSnapshot({ runWorktreePath: dir, snapshotSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
        } catch (err) {
          expect(err).toBeInstanceOf(SnapshotProvisionError);
        }
      });
    });

    it('dispose removes the worktree and is idempotent', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        const snapshotSha = await captureSnapshotSha(dir);
        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });

        await provision.dispose();

        await expect(fsPromises.access(provision.worktreePath)).rejects.toThrow();
        const worktreeList = git(dir, ['worktree', 'list', '--porcelain']);
        expect(worktreeList).not.toContain(provision.worktreePath);

        // Idempotent: a second dispose() must not throw.
        await expect(provision.dispose()).resolves.toBeUndefined();
      });
    });

    it('dispose after manual deletion of the worktree dir does not throw', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        const snapshotSha = await captureSnapshotSha(dir);
        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });

        await fsPromises.rm(provision.worktreePath, { recursive: true, force: true });

        await expect(provision.dispose()).resolves.toBeUndefined();
      });
    });
  });

  describe('resolveDefaultDepPreparer', () => {
    it('CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER=1 disables the default preparer (rollback lever)', () => {
      // Set by the file-wide beforeEach — this is the assertion that it bites.
      expect(resolveDefaultDepPreparer()).toBeNull();
    });

    it('resolves (and memoizes) a preparer rooted at <CYBOFLOW_DIR>/verify-deps when enabled', async () => {
      await withTempDir('snapshot-provisioner-cyboflow-dir-', async (dir) => {
        const previousDir = process.env.CYBOFLOW_DIR;
        delete process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER;
        process.env.CYBOFLOW_DIR = dir;
        try {
          const first = resolveDefaultDepPreparer();
          expect(first).toBeInstanceOf(VerifyDepPreparer);
          // Memoized per base dir — the same instance, not a new one per call.
          expect(resolveDefaultDepPreparer()).toBe(first);
          // Resolution is lazy AND inert: nothing is created until a real
          // prepare() actually builds a set.
          await expect(fsPromises.access(path.join(dir, 'verify-deps'))).rejects.toThrow();
        } finally {
          if (previousDir === undefined) delete process.env.CYBOFLOW_DIR;
          else process.env.CYBOFLOW_DIR = previousDir;
        }
      });
    });
  });
});
