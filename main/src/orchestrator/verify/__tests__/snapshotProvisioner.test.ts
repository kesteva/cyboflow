/**
 * snapshotProvisioner tests — run against a REAL throwaway git repo fixture
 * (no DB, no Electron). Covers captureSnapshotSha, isPathspecDirty,
 * provisionSnapshot's exact-sha checkout + node_modules symlinking, the typed
 * bad-sha error, and dispose's unconditional/idempotent teardown.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import {
  captureSnapshotSha,
  isPathspecDirty,
  provisionSnapshot,
  findDependencyDirs,
  SnapshotProvisionError,
} from '../snapshotProvisioner';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Initializes a fixture repo with an initial commit, config'd for CI commits. */
async function initFixtureRepo(dir: string): Promise<void> {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@cyboflow.dev']);
  git(dir, ['config', 'user.name', 'Cyboflow Test']);
  await fsPromises.writeFile(path.join(dir, 'README.md'), 'v1\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

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

  describe('isPathspecDirty', () => {
    it('is false on a clean tree', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        await expect(isPathspecDirty(dir)).resolves.toBe(false);
      });
    });

    it('is true when a tracked file is modified', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        await fsPromises.writeFile(path.join(dir, 'README.md'), 'v2\n');

        await expect(isPathspecDirty(dir)).resolves.toBe(true);
      });
    });

    it('is true when an untracked file exists under the given path', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        await fsPromises.mkdir(path.join(dir, 'sub'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'sub', 'new.txt'), 'new\n');

        await expect(isPathspecDirty(dir, ['sub'])).resolves.toBe(true);
      });
    });

    it('scopes to the given paths — dirt outside them is not reported', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        await fsPromises.mkdir(path.join(dir, 'scoped'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'scoped', 'clean.txt'), 'clean\n');
        git(dir, ['add', 'scoped/clean.txt']);
        git(dir, ['commit', '-q', '-m', 'add scoped dir']);

        // Dirty a file OUTSIDE the scoped path.
        await fsPromises.writeFile(path.join(dir, 'README.md'), 'v2\n');

        await expect(isPathspecDirty(dir, ['scoped'])).resolves.toBe(false);
        // Sanity: the same tree IS dirty when checked unscoped.
        await expect(isPathspecDirty(dir)).resolves.toBe(true);
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

    it('symlinks node_modules dirs (root + nested) and skips scanning inside node_modules', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);

        // Root-level node_modules with a marker file.
        await fsPromises.mkdir(path.join(dir, 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'node_modules', 'marker.txt'), 'root-marker\n');

        // A nested workspace node_modules.
        await fsPromises.mkdir(path.join(dir, 'sub', 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'sub', 'node_modules', 'marker.txt'), 'sub-marker\n');
        // `sub` itself must exist in the snapshot's checked-out tree for the
        // link to land — track it via a placeholder file and commit.
        await fsPromises.writeFile(path.join(dir, 'sub', 'keep.txt'), 'keep\n');
        git(dir, ['add', 'sub/keep.txt']);
        git(dir, ['commit', '-q', '-m', 'add sub dir']);

        // node_modules-inside-node_modules: must never be scanned as an
        // independent top-level dependency dir.
        await fsPromises.mkdir(path.join(dir, 'node_modules', 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'node_modules', 'node_modules', 'inner.txt'), 'inner\n');

        const found = await findDependencyDirs(dir);
        const relFound = found.map((f) => path.relative(dir, f)).sort();
        expect(relFound).toEqual(['node_modules', 'sub/node_modules'].sort());
        expect(relFound).not.toContain(path.join('node_modules', 'node_modules'));

        const snapshotSha = await captureSnapshotSha(dir);
        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });
        try {
          const rootMarker = await fsPromises.readFile(
            path.join(provision.worktreePath, 'node_modules', 'marker.txt'),
            'utf8',
          );
          expect(rootMarker).toBe('root-marker\n');

          const subMarker = await fsPromises.readFile(
            path.join(provision.worktreePath, 'sub', 'node_modules', 'marker.txt'),
            'utf8',
          );
          expect(subMarker).toBe('sub-marker\n');

          const rootLinkStat = await fsPromises.lstat(path.join(provision.worktreePath, 'node_modules'));
          expect(rootLinkStat.isSymbolicLink()).toBe(true);
          const subLinkStat = await fsPromises.lstat(path.join(provision.worktreePath, 'sub', 'node_modules'));
          expect(subLinkStat.isSymbolicLink()).toBe(true);
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
});
