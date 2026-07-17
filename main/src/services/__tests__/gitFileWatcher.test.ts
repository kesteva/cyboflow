import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { GitFileWatcher } from '../gitFileWatcher';

/**
 * These tests lock the watch-attachment POLICY (which paths get an fs.watch)
 * rather than FSEvents delivery, which is timing-flaky and platform-dependent.
 * The policy is the fix: never point a recursive watcher at node_modules / .git,
 * whose churn during a sibling lane's install/build otherwise floods the callback.
 */
describe('GitFileWatcher attachment policy', () => {
  let watcher: GitFileWatcher | undefined;

  afterEach(() => {
    watcher?.stopAll();
    watcher = undefined;
  });

  function scaffold(root: string): void {
    for (const dir of ['node_modules', '.git', 'src', 'frontend']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    // A nested file under node_modules to prove we don't descend into it, and a
    // top-level file to prove non-directory entries never get a recursive watch.
    writeFileSync(join(root, 'node_modules', 'dep.js'), '// noise');
    writeFileSync(join(root, 'package.json'), '{}');
  }

  it('watches root + each non-excluded top-level dir, never node_modules/.git', async () => {
    await withTempDir('gitfilewatcher-policy-', (root) => {
      scaffold(root);
      watcher = new GitFileWatcher();
      watcher.startWatching('s1', root);

      const topDirs = watcher.getWatchedTopDirs('s1');
      expect(topDirs).toBeDefined();
      expect(new Set(topDirs)).toEqual(new Set(['src', 'frontend']));
      expect(topDirs).not.toContain('node_modules');
      expect(topDirs).not.toContain('.git');

      // Root (non-recursive) + src + frontend = 3 watchers total.
      expect(watcher.getStats().totalWatchers).toBe(3);
    });
  });

  it('attaches no recursive watchers when only excluded dirs exist (root only)', async () => {
    await withTempDir('gitfilewatcher-excluded-only-', (root) => {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      mkdirSync(join(root, '.git'), { recursive: true });
      watcher = new GitFileWatcher();
      watcher.startWatching('s1', root);

      expect(watcher.getWatchedTopDirs('s1')).toEqual([]);
      // Only the root non-recursive watcher.
      expect(watcher.getStats().totalWatchers).toBe(1);
    });
  });

  it('stopWatching closes every watcher and forgets the session (no fd leak)', async () => {
    await withTempDir('gitfilewatcher-stop-', (root) => {
      scaffold(root);
      watcher = new GitFileWatcher();
      watcher.startWatching('s1', root);
      expect(watcher.getStats().totalWatched).toBe(1);
      expect(watcher.getStats().totalWatchers).toBe(3);

      watcher.stopWatching('s1');
      expect(watcher.getStats().totalWatched).toBe(0);
      expect(watcher.getStats().totalWatchers).toBe(0);
      expect(watcher.getWatchedTopDirs('s1')).toBeUndefined();
    });
  });

  it('starting a second session replaces the first watcher set cleanly', async () => {
    await withTempDir('gitfilewatcher-restart-', (root) => {
      scaffold(root);
      watcher = new GitFileWatcher();
      watcher.startWatching('s1', root);
      // Re-starting the same session id must not double-watch.
      watcher.startWatching('s1', root);

      expect(watcher.getStats().totalWatched).toBe(1);
      expect(watcher.getStats().totalWatchers).toBe(3);
    });
  });
});
