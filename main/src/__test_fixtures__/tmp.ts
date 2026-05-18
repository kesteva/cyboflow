/**
 * Test helper: create a unique temp directory for the duration of an async
 * callback, then unconditionally clean it up. Mirrors Python's
 * tempfile.TemporaryDirectory contextmanager pattern.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

/**
 * Run `fn` with a fresh temp dir; clean up after fn resolves OR throws.
 *
 * Usage:
 *   await withTempDir('runlauncher-test-', async (tmpDir) => {
 *     // ... use tmpDir ...
 *   });
 *
 * Cleanup is best-effort (rmSync with force: true) so a partially-deleted
 * dir on Windows or NFS does not mask the original test failure.
 */
export async function withTempDir<T>(
  prefix: string,
  fn: (tmpDir: string) => Promise<T> | T,
): Promise<T> {
  const tmpDir = mkdtempSync(join(tmpdir(), `${prefix}${randomUUID().slice(0, 8)}-`));
  try {
    return await fn(tmpDir);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
