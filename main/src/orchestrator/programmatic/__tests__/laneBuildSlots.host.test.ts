/**
 * Lane build slots + the commit probe for a REMOTE run (spec M2 §5 D3): every exclude / git / mkdir / existence
 * read goes through the run's host, the slot dir and lane env are POSIX paths under the remote worktree, and This
 * Mac's git, exclude writer and fs are NEVER called (spied below).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const local = vi.hoisted(() => ({
  runGitAsync: vi.fn(),
  runGitExit: vi.fn(),
  ensureGitExcludeEntries: vi.fn(),
  mkdir: vi.fn(),
  existsSync: vi.fn(),
}));
vi.mock('../../../utils/runGit', async (orig) => {
  const real = await orig<typeof import('../../../utils/runGit')>();
  return {
    ...real,
    runGitAsync: local.runGitAsync.mockImplementation(real.runGitAsync),
    runGitExit: local.runGitExit.mockImplementation(real.runGitExit),
  };
});
vi.mock('../../../utils/gitExcludeWriter', async (orig) => {
  const real = await orig<typeof import('../../../utils/gitExcludeWriter')>();
  return { ...real, ensureGitExcludeEntries: local.ensureGitExcludeEntries.mockImplementation(real.ensureGitExcludeEntries) };
});
vi.mock('fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>();
  return { ...real, mkdir: local.mkdir.mockImplementation(real.mkdir) };
});
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>();
  return { ...real, existsSync: local.existsSync.mockImplementation(real.existsSync) };
});

import { hostLaneBuildSlotsDeps, LANE_SCRATCH_DIR_ENV, LaneBuildSlots } from '../laneBuildSlots';
import { checkHostWorktreeBuildSlots, worktreeProbe } from '../laneBuildSlotsWiring';
import { fakeRunWorktreeHost } from './fakeRunWorktreeHost';
import type { RunHostGitExit } from '../../trpc/contracts/runHostAccess';

const WT = '/home/k/cf-remote/h1/wt/s1';

function expectNoLocalCalls(): void {
  expect(local.runGitAsync).not.toHaveBeenCalled();
  expect(local.runGitExit).not.toHaveBeenCalled();
  expect(local.ensureGitExcludeEntries).not.toHaveBeenCalled();
  expect(local.mkdir).not.toHaveBeenCalled();
  expect(local.existsSync).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const fn of Object.values(local)) fn.mockClear();
});

describe('LaneBuildSlots on a remote worktree', () => {
  it('verifies through the host git, creates the slot on the host, and hands out remote POSIX paths', async () => {
    const calls: string[][] = [];
    const host = fakeRunWorktreeHost({
      git: (_cwd, args): RunHostGitExit => {
        calls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const slots = new LaneBuildSlots(WT, hostLaneBuildSlotsDeps(host, 15_000), undefined, { posixPaths: true });

    const scratch = await slots.resolve(1);

    const dir = `${WT}/.cyboflow/build-slots/slot-1`;
    expect(scratch).toEqual({
      slot: 1,
      dir,
      env: {
        [LANE_SCRATCH_DIR_ENV]: dir,
        CLANG_MODULE_CACHE_PATH: `${dir}/clang-module-cache`,
        SWIFTPM_MODULECACHE_OVERRIDE: `${dir}/clang-module-cache`,
      },
    });
    expect(calls).toEqual([
      ['ls-files', '--', '.cyboflow/build-slots'],
      ['check-ignore', '-q', '--', '.cyboflow/build-slots/'],
    ]);
    expect(host.gitExit).toHaveBeenCalledWith(WT, ['check-ignore', '-q', '--', '.cyboflow/build-slots/'], { timeoutMs: 15_000 });
    expect(host.mkdirp).toHaveBeenCalledWith(dir);
    expectNoLocalCalls();
  });

  it('gives no slot (and reports why) when the environment says the root is not ignored', async () => {
    const host = fakeRunWorktreeHost({
      git: (_cwd, args): RunHostGitExit => ({ exitCode: args[0] === 'check-ignore' ? 1 : 0, stdout: '', stderr: '' }),
    });
    const slots = new LaneBuildSlots(WT, hostLaneBuildSlotsDeps(host, 15_000), undefined, { posixPaths: true });
    const reasons: string[] = [];
    slots.setUnavailableListener((r) => reasons.push(r));

    expect(await slots.resolve(0)).toBeUndefined();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('git does not ignore');
    expect(host.mkdirp).not.toHaveBeenCalled();
    expectNoLocalCalls();
  });

  it('gives no slot when the environment is unreachable (a rejected git counts as unverified)', async () => {
    const host = fakeRunWorktreeHost();
    host.gitExit.mockRejectedValue(new Error('Environments are turned off.'));
    const slots = new LaneBuildSlots(WT, hostLaneBuildSlotsDeps(host, 15_000), undefined, { posixPaths: true });
    expect(await slots.resolve(0)).toBeUndefined();
    expectNoLocalCalls();
  });
});

describe('commit probe on a remote worktree', () => {
  it('reads HEAD / status through the host and checks build slots there', async () => {
    const host = fakeRunWorktreeHost({
      git: (_cwd, args): RunHostGitExit =>
        args[0] === 'rev-parse' ? { exitCode: 0, stdout: 'abc\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' },
    });
    const probe = worktreeProbe(WT, host);

    expect(await probe.git(['rev-parse', 'HEAD'])).toBe('abc\n');
    expect(await probe.buildSlots()).toEqual({ kind: 'clean' });
    expect(host.gitCapture).toHaveBeenCalledWith(WT, ['rev-parse', 'HEAD']);
    expect(host.gitExit.mock.calls.every(([cwd]) => cwd === WT)).toBe(true);
    expectNoLocalCalls();
  });

  it('reads an unreadable tree as unknown when the slots root exists on the environment', async () => {
    const host = fakeRunWorktreeHost({
      dirs: [`${WT}/.cyboflow/build-slots`],
      git: (): RunHostGitExit => ({ exitCode: 128, stdout: '', stderr: 'fatal' }),
    });
    expect(await checkHostWorktreeBuildSlots(WT, host)).toEqual({ kind: 'unknown' });
    expect(host.exists).toHaveBeenCalledWith(`${WT}/.cyboflow/build-slots`);
    expectNoLocalCalls();
  });

  it('a This-Mac run keeps the local git (control)', async () => {
    const probe = worktreeProbe('/nonexistent-cyboflow-wt');
    await expect(probe.git(['rev-parse', 'HEAD'])).rejects.toBeDefined();
    expect(local.runGitAsync).toHaveBeenCalledWith('/nonexistent-cyboflow-wt', ['rev-parse', 'HEAD']);
  });
});
