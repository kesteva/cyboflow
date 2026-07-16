/**
 * Operational-failure classification for the async git plumbing helpers
 * (Codex adversarial-review finding 2).
 *
 * A child killed by our `timeout` (Node execFile sets killed=true / signal=SIGTERM),
 * killed by another signal, or failing to spawn (ENOENT) must NOT be flattened into a
 * valid-looking zero result — that silently caches an ahead/diverged worktree as clean
 * and hides merge readiness. Those cases throw GitOperationalError so GitStatusManager
 * preserves last-known status. A genuine git-semantic non-zero exit (a NUMERIC exit
 * code with killed=false, e.g. an unknown revision) still degrades to zero as before.
 *
 * runGitAsync is mocked so the failure mode is deterministic — a real timeout kill is
 * inherently racy. The real-git parity behaviors live in gitPlumbingCommands.test.ts;
 * that file uses real git + temp dirs and must stay unmocked, hence a separate file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/runGit', () => ({
  runGitAsync: vi.fn(),
}));

import { runGitAsync } from '../../utils/runGit';
import { fastGetAheadBehind, fastGetDiffStats, GitOperationalError } from '../gitPlumbingCommands';

// An existing directory so the fs.accessSync guard at the top of each helper passes
// and control actually reaches the (mocked) runGitAsync call.
const EXISTING_DIR = process.cwd();

/** Node execFile timeout kill: killed=true, signal set, code null. */
function timeoutKillError(): Error {
  return Object.assign(new Error('git killed after timeout'), {
    killed: true,
    signal: 'SIGTERM' as const,
    code: null,
  });
}
/** Killed by a signal without the killed flag (defensive: signal alone counts). */
function signalKillError(): Error {
  return Object.assign(new Error('git killed'), { killed: false, signal: 'SIGKILL' as const });
}
/** Spawn failure — git binary or cwd not found. */
function spawnError(): Error {
  return Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
}
/** git RAN and exited non-zero (e.g. unknown revision) — semantic, NOT operational. */
function semanticExitError(): Error {
  return Object.assign(new Error('fatal: bad revision'), { code: 128, killed: false, signal: null });
}

beforeEach(() => {
  vi.mocked(runGitAsync).mockReset();
});

describe('fastGetAheadBehind — operational vs semantic failure (finding 2)', () => {
  it('throws GitOperationalError when the child is killed by the timeout', async () => {
    vi.mocked(runGitAsync).mockRejectedValueOnce(timeoutKillError());
    await expect(fastGetAheadBehind(EXISTING_DIR, 'main')).rejects.toBeInstanceOf(GitOperationalError);
  });

  it('throws GitOperationalError when the child is killed by a signal', async () => {
    vi.mocked(runGitAsync).mockRejectedValueOnce(signalKillError());
    await expect(fastGetAheadBehind(EXISTING_DIR, 'main')).rejects.toBeInstanceOf(GitOperationalError);
  });

  it('throws GitOperationalError on a spawn failure (ENOENT)', async () => {
    vi.mocked(runGitAsync).mockRejectedValueOnce(spawnError());
    await expect(fastGetAheadBehind(EXISTING_DIR, 'main')).rejects.toBeInstanceOf(GitOperationalError);
  });

  it('still degrades a semantic non-zero git exit to {0,0} (unchanged pre-existing behavior)', async () => {
    vi.mocked(runGitAsync).mockRejectedValueOnce(semanticExitError());
    await expect(fastGetAheadBehind(EXISTING_DIR, 'main')).resolves.toEqual({ ahead: 0, behind: 0 });
  });
});

describe('fastGetDiffStats — operational vs semantic failure (finding 2)', () => {
  it('throws GitOperationalError when the child is killed by the timeout', async () => {
    vi.mocked(runGitAsync).mockRejectedValueOnce(timeoutKillError());
    await expect(fastGetDiffStats(EXISTING_DIR)).rejects.toBeInstanceOf(GitOperationalError);
  });

  it('still degrades a semantic non-zero git exit to zero stats', async () => {
    vi.mocked(runGitAsync).mockRejectedValueOnce(semanticExitError());
    await expect(fastGetDiffStats(EXISTING_DIR)).resolves.toEqual({
      additions: 0,
      deletions: 0,
      filesChanged: 0,
    });
  });
});
