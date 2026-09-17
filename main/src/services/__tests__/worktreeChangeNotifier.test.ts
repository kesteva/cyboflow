/**
 * WorktreeChangeNotifier — the rail Diff tab's "go refetch" signal.
 *
 * Real temp repos and real fs.watch (FSEvents on macOS / inotify on Linux),
 * because the whole point is the two sources it fuses: worktree file events
 * (GitFileWatcher in 'always' mode) and git-dir events (index / HEAD /
 * MERGE_HEAD) the file watcher deliberately never sees. Timings are generous:
 * GitFileWatcher debounces 1.5 s and the notifier coalesces 300 ms on top.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { WorktreeChangeNotifier } from '../worktreeChangeNotifier';

function git(dir: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir: string): void {
  git(dir, 'init');
  git(dir, 'config user.email "test@example.com"');
  git(dir, 'config user.name "Test"');
  git(dir, 'checkout -b main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\n');
  git(dir, 'add -A');
  git(dir, 'commit -m base');
}

/** Resolve once `count` notifications have arrived, or reject after `ms`. */
function waitForCalls(getCount: () => number, count: number, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (getCount() >= count) return resolve();
      if (Date.now() - started > ms) return reject(new Error(`only ${getCount()} notifications after ${ms}ms`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Let the watchers settle after attach — fs.watch needs a beat before it reports. */
const settle = () => new Promise((r) => setTimeout(r, 400));

describe('WorktreeChangeNotifier', () => {
  it('notifies on a worktree file edit, and stops notifying after unsubscribe', async () => {
    await withTempDir('wt-notifier-edit-', async (repo) => {
      initRepo(repo);
      const notifier = new WorktreeChangeNotifier();
      let calls = 0;
      const unsubscribe = notifier.subscribe('s1', repo, () => {
        calls += 1;
      });
      expect(notifier.watchedCount).toBe(1);
      await settle();

      fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\na2-dirty\n');
      await waitForCalls(() => calls, 1, 6000);

      unsubscribe();
      expect(notifier.watchedCount).toBe(0);
      const after = calls;
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\na2-dirty\na3\n');
      await new Promise((r) => setTimeout(r, 2500));
      expect(calls).toBe(after);
    });
  }, 20_000);

  it('notifies on an index-only change (`git add` from a terminal) that touches no worktree file', async () => {
    await withTempDir('wt-notifier-index-', async (repo) => {
      initRepo(repo);
      // Dirty the tree BEFORE subscribing so the only event after subscribe
      // is the index write.
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\nstaged\n');
      const notifier = new WorktreeChangeNotifier();
      let calls = 0;
      const unsubscribe = notifier.subscribe('s1', repo, () => {
        calls += 1;
      });
      // The git dir is resolved asynchronously (one spawn) — give it time.
      await new Promise((r) => setTimeout(r, 800));

      git(repo, 'add a.txt');
      await waitForCalls(() => calls, 1, 6000);
      unsubscribe();
    });
  }, 20_000);

  it('a linked worktree resolves ITS git dir (…/.git/worktrees/<name>), so its own index changes notify', async () => {
    await withTempDir('wt-notifier-linked-', async (main) => {
      initRepo(main);
      const linked = path.join(main, '..', `${path.basename(main)}-linked`);
      git(main, `worktree add -b feature "${linked}"`);
      try {
        fs.writeFileSync(path.join(linked, 'a.txt'), 'a1\nlinked-staged\n');
        const notifier = new WorktreeChangeNotifier();
        let calls = 0;
        const unsubscribe = notifier.subscribe('s-linked', linked, () => {
          calls += 1;
        });
        await new Promise((r) => setTimeout(r, 800));

        git(linked, 'add a.txt');
        await waitForCalls(() => calls, 1, 6000);
        unsubscribe();
      } finally {
        try {
          git(main, `worktree remove --force "${linked}"`);
        } catch {
          fs.rmSync(linked, { recursive: true, force: true });
        }
      }
    });
  }, 20_000);

  it('refcounts: two listeners share one watcher set and the set survives the first unsubscribe', async () => {
    await withTempDir('wt-notifier-refcount-', async (repo) => {
      initRepo(repo);
      const notifier = new WorktreeChangeNotifier();
      let a = 0;
      let b = 0;
      const unsubA = notifier.subscribe('s1', repo, () => {
        a += 1;
      });
      const unsubB = notifier.subscribe('s1', repo, () => {
        b += 1;
      });
      expect(notifier.watchedCount).toBe(1);
      await settle();

      fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
      await waitForCalls(() => Math.min(a, b), 1, 6000);

      unsubA();
      expect(notifier.watchedCount).toBe(1);
      unsubA(); // idempotent
      expect(notifier.watchedCount).toBe(1);
      unsubB();
      expect(notifier.watchedCount).toBe(0);
    });
  }, 20_000);

  it('a worktree that cannot be watched never throws from subscribe', () => {
    const notifier = new WorktreeChangeNotifier();
    const unsubscribe = notifier.subscribe('s-missing', '/nonexistent/path/for/notifier', () => {});
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
    expect(notifier.watchedCount).toBe(0);
  });
});
