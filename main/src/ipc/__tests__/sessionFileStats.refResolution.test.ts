/**
 * resolveSessionDiffBaseRef — TASK-208 SHA-resolution + option-injection guard.
 *
 * Colocated alongside sessionFileStats.test.ts (which exercises the resolver
 * against real git repos) but split into its own mocked-runGitAsync file:
 * proving "a `-`-prefixed candidate is skipped rather than passed through to
 * git" needs to observe the exact argv `resolveSessionDiffBaseRef` builds,
 * which a real-repo test cannot do without itself depending on git's option
 * parsing. sessionFileStats.test.ts already mixes real git throughout, so a
 * module-level `vi.mock('../../utils/runGit', ...)` cannot live there too
 * (vi.mock is hoisted and file-scoped).
 *
 * These cases assert the REQUIRED post-fix contract and are expected to FAIL
 * against the pre-fix resolver, which:
 *   - returns the raw candidate string (not rev-parse's resolved output), and
 *   - calls `rev-parse --verify --quiet <candidate>^{commit}` WITHOUT
 *     END_OF_OPTIONS, so a `-`-prefixed candidate is passed straight through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRunGitAsync } = vi.hoisted(() => ({
  mockRunGitAsync: vi.fn<(cwd: string, args: string[]) => Promise<string>>(),
}));

vi.mock('../../utils/runGit', () => ({
  runGitAsync: mockRunGitAsync,
  runGit: vi.fn(),
  END_OF_OPTIONS: '--end-of-options',
}));

import { resolveSessionDiffBaseRef } from '../sessionFileStats';

const WORKTREE = '/tmp/project/fake-worktree';

describe('resolveSessionDiffBaseRef — SHA resolution + option-injection guard (TASK-208)', () => {
  beforeEach(() => {
    mockRunGitAsync.mockReset();
  });

  it('returns the RESOLVED SHA from rev-parse stdout, not the candidate string itself', async () => {
    const resolvedSha = 'f'.repeat(40);
    mockRunGitAsync.mockResolvedValueOnce(`${resolvedSha}\n`);

    const result = await resolveSessionDiffBaseRef(WORKTREE, ['main']);

    expect(result).toBe(resolvedSha);
    expect(result).not.toBe('main');
  });

  it('issues rev-parse --verify together with END_OF_OPTIONS', async () => {
    mockRunGitAsync.mockResolvedValueOnce(`${'a'.repeat(40)}\n`);

    await resolveSessionDiffBaseRef(WORKTREE, ['main']);

    expect(mockRunGitAsync).toHaveBeenCalledWith(
      WORKTREE,
      expect.arrayContaining(['rev-parse', '--verify', '--end-of-options']),
    );
  });

  it('skips a `-`-prefixed candidate rather than passing it through to git, and falls through to the next candidate', async () => {
    const resolvedSha = 'b'.repeat(40);
    // Only ONE real git invocation should happen (for the safe 'main'
    // candidate) — the option-like candidate must be rejected locally.
    mockRunGitAsync.mockResolvedValueOnce(`${resolvedSha}\n`);

    const result = await resolveSessionDiffBaseRef(WORKTREE, ['--output=/tmp/cyboflow-pwn-baseref', 'main']);

    expect(result).toBe(resolvedSha);
    expect(mockRunGitAsync).toHaveBeenCalledTimes(1);
    for (const call of mockRunGitAsync.mock.calls) {
      const [, args] = call;
      expect(args.some((a) => a.startsWith('--output='))).toBe(false);
    }
  });

  it('returns null when every candidate is rejected or fails to resolve', async () => {
    mockRunGitAsync.mockRejectedValue(new Error('unknown revision'));

    const result = await resolveSessionDiffBaseRef(WORKTREE, ['--output=/tmp/cyboflow-pwn-baseref-2', 'no-such-branch']);

    expect(result).toBeNull();
  });
});
