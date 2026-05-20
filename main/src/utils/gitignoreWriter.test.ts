import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureGitignoreEntry } from './gitignoreWriter';
import { withTempDir } from '../__test_fixtures__/tmp';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readGitignore(dir: string): string {
  return fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureGitignoreEntry', () => {
  const ENTRY = '.cyboflow/worktrees/';

  describe('when .gitignore does not exist', () => {
    it('creates the file with the entry followed by a newline', async () => {
      await withTempDir('gitignore-test-', async (dir) => {
        ensureGitignoreEntry(dir, ENTRY);
        expect(readGitignore(dir)).toBe('.cyboflow/worktrees/\n');
      });
    });
  });

  describe('idempotency — entry already present', () => {
    it('does not append a duplicate when exact entry is already present', async () => {
      await withTempDir('gitignore-test-', async (dir) => {
        fs.writeFileSync(path.join(dir, '.gitignore'), '.cyboflow/worktrees/\n', 'utf8');
        ensureGitignoreEntry(dir, ENTRY);
        expect(readGitignore(dir)).toBe('.cyboflow/worktrees/\n');
      });
    });

    it('does not append when entry without trailing slash is present', async () => {
      await withTempDir('gitignore-test-', async (dir) => {
        fs.writeFileSync(path.join(dir, '.gitignore'), '.cyboflow/worktrees\n', 'utf8');
        ensureGitignoreEntry(dir, ENTRY);
        expect(readGitignore(dir)).toBe('.cyboflow/worktrees\n');
      });
    });

    it('does not append when entry with leading slash is present', async () => {
      await withTempDir('gitignore-test-', async (dir) => {
        fs.writeFileSync(path.join(dir, '.gitignore'), '/.cyboflow/worktrees/\n', 'utf8');
        ensureGitignoreEntry(dir, ENTRY);
        expect(readGitignore(dir)).toBe('/.cyboflow/worktrees/\n');
      });
    });
  });

  describe('trailing-newline handling', () => {
    it('prepends a newline before the entry when the file does not end with one', async () => {
      await withTempDir('gitignore-test-', async (dir) => {
        // Deliberately no trailing newline
        fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules', 'utf8');
        ensureGitignoreEntry(dir, ENTRY);
        expect(readGitignore(dir)).toBe('node_modules\n.cyboflow/worktrees/\n');
      });
    });

    it('does not add an extra blank line when the file already ends with a newline', async () => {
      await withTempDir('gitignore-test-', async (dir) => {
        fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n', 'utf8');
        ensureGitignoreEntry(dir, ENTRY);
        expect(readGitignore(dir)).toBe('node_modules\n.cyboflow/worktrees/\n');
      });
    });
  });

  describe('error handling', () => {
    it('swallows fs errors and does not rethrow', () => {
      // Pass a non-existent path whose parent does not exist — fs.writeFileSync will
      // throw ENOENT (no such file or directory).  The key assertion is that no
      // exception propagates to the caller.
      const nonExistentParent = path.join(os.tmpdir(), 'gitignore-no-such-dir-' + Date.now(), 'proj');
      expect(() => ensureGitignoreEntry(nonExistentParent, ENTRY)).not.toThrow();
    });

    it('logs a console.error message when an fs error occurs', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const nonExistentParent = path.join(os.tmpdir(), 'gitignore-no-such-dir-' + Date.now(), 'proj');
      ensureGitignoreEntry(nonExistentParent, ENTRY);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[gitignoreWriter]'),
        expect.anything()
      );

      consoleSpy.mockRestore();
    });
  });
});
