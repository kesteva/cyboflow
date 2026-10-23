/**
 * Production wiring of the lane build slots: the boot-time env strip, the
 * LOCAL `LaneBuildSlotsDeps` the programmatic runner binds for a This-Mac run
 * (the real exclude writer, git and mkdir), and the commit probe's lane-end
 * build-slot check with its real git runner and filesystem check bound — for
 * This Mac, or through the run's host for a remote run. Kept here so index.ts
 * (a size-ratcheted file) needs one import and one call each, and so the
 * runner itself imports no fs.
 */

import * as fs from 'fs';
import { mkdir } from 'fs/promises';
import * as path from 'path';
import { ensureGitExcludeEntries } from '../../utils/gitExcludeWriter';
import { runGitAsync, runGitExit } from '../../utils/runGit';
import type { RunWorktreeHost } from '../trpc/contracts/runHostAccess';
import type { LoggerLike } from '../types';
import { checkCommittedBuildSlots } from './commitIntegrity';
import { verifyLaneBuildSlotsIgnored, type LaneBuildSlotsDeps } from './laneBuildSlots';
import type { BuildSlotCheck } from './types';

export { stripInheritedLaneEnv } from './laneBuildSlots';

/**
 * The THIS-MAC deps of a run's LaneBuildSlots: the worktree's local git
 * exclude, real git (each call bounded by `gitTimeoutMs`) and `mkdir -p`.
 */
export function localLaneBuildSlotsDeps(gitTimeoutMs: number, logger?: LoggerLike): LaneBuildSlotsDeps {
  return {
    ensureExcluded: (worktreePath, entries) =>
      ensureGitExcludeEntries(worktreePath, entries, {
        label: 'LaneBuildSlots',
        ...(logger ? { logger } : {}),
      }) !== null,
    verifyIgnored: (worktreePath, root) =>
      verifyLaneBuildSlotsIgnored(worktreePath, root, (cwd, args) =>
        runGitExit(cwd, args, { timeout: gitTimeoutMs }),
      ),
    mkdirp: async (dirPath) => {
      await mkdir(dirPath, { recursive: true });
    },
  };
}

/**
 * Does the lane-end HEAD of `worktreePath` carry committed lane build output?
 * {@link checkCommittedBuildSlots} with real git and a real existence check.
 */
export function checkWorktreeBuildSlots(worktreePath: string): Promise<BuildSlotCheck> {
  return checkCommittedBuildSlots(
    (args) => runGitExit(worktreePath, args),
    (rel) => fs.existsSync(path.join(worktreePath, rel)),
  );
}

/**
 * {@link checkWorktreeBuildSlots} for a worktree on a REMOTE environment: the
 * same check with the host's git and existence probe (POSIX paths). Nothing
 * runs on This Mac.
 */
export function checkHostWorktreeBuildSlots(worktreePath: string, host: RunWorktreeHost): Promise<BuildSlotCheck> {
  return checkCommittedBuildSlots(
    (args) => host.gitExit(worktreePath, args),
    (rel) => host.exists(path.posix.join(worktreePath, rel)),
  );
}

/** The git + build-slot reads of the lane commit-integrity probe, bound to one run worktree. */
export interface WorktreeProbe {
  /** `git <args>` in the worktree; stdout on exit 0, rejects otherwise (runGitAsync parity). */
  git(args: string[]): Promise<string>;
  /** {@link checkWorktreeBuildSlots} for the worktree. */
  buildSlots(): Promise<BuildSlotCheck>;
}

/**
 * The commit probe's reads for a run worktree: This Mac's git and filesystem
 * when `host` is absent (unchanged), the run's environment when it is given
 * (spec M2 §5 D3) — so a remote run's probe never runs local git on a remote path
 * (which would fail every lane's probe and silently drop the backstop).
 */
export function worktreeProbe(worktreePath: string, host?: RunWorktreeHost): WorktreeProbe {
  if (host === undefined) {
    return {
      git: (args) => runGitAsync(worktreePath, args),
      buildSlots: () => checkWorktreeBuildSlots(worktreePath),
    };
  }
  return {
    git: (args) => host.gitCapture(worktreePath, args),
    buildSlots: () => checkHostWorktreeBuildSlots(worktreePath, host),
  };
}
