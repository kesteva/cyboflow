/**
 * Unit tests for withTempDir helper.
 *
 * Behaviors covered (per TASK-605 test_strategy):
 * 1. withTempDir creates a unique directory under os.tmpdir() with the given prefix
 * 2. withTempDir cleans up the directory after the callback resolves
 * 3. withTempDir cleans up the directory even if the callback throws
 * 4. withTempDir cleanup is best-effort — does not throw on a non-existent dir
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { withTempDir } from '../tmp';

describe('withTempDir', () => {
  it('creates a unique directory under os.tmpdir() with the given prefix', async () => {
    let capturedDir: string | null = null;

    await withTempDir('test-prefix-', async (dir) => {
      capturedDir = dir;
      expect(existsSync(dir)).toBe(true);
      expect(dir).toContain(tmpdir());
      expect(dir).toMatch(/test-prefix-/);
    });

    // dir must have existed during the callback
    expect(capturedDir).not.toBeNull();
  });

  it('cleans up the directory after the callback resolves', async () => {
    let capturedDir: string | null = null;

    await withTempDir('cleanup-test-', async (dir) => {
      capturedDir = dir;
      expect(existsSync(dir)).toBe(true);
    });

    // dir must be gone after withTempDir returns
    expect(existsSync(capturedDir!)).toBe(false);
  });

  it('cleans up the directory even if the callback throws', async () => {
    let capturedDir: string | null = null;

    await expect(
      withTempDir('throw-test-', async (dir) => {
        capturedDir = dir;
        expect(existsSync(dir)).toBe(true);
        throw new Error('deliberate test error');
      }),
    ).rejects.toThrow('deliberate test error');

    // dir must be gone even though callback threw
    expect(existsSync(capturedDir!)).toBe(false);
  });

  it('cleanup is best-effort — does not throw when the dir was already removed', async () => {
    // withTempDir uses rmSync with force: true, so it silently swallows "not found".
    // We verify this by calling withTempDir and manually removing the dir inside
    // the callback — the finalizer should not throw.
    const { rmSync } = await import('fs');

    await expect(
      withTempDir('force-test-', async (dir) => {
        // Remove the dir before withTempDir's own cleanup runs
        rmSync(dir, { recursive: true, force: true });
        // The dir is now gone, but withTempDir must not throw in its finally block
      }),
    ).resolves.toBeUndefined();
  });
});
