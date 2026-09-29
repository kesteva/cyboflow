/**
 * Production wiring of the lane build slots for the main-process composition
 * root (index.ts): the boot-time env strip and the commit probe's lane-end
 * build-slot check with its real git runner and filesystem check bound. Kept
 * here so index.ts (a size-ratcheted file) needs one import and one call each.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runGitExit } from '../../utils/runGit';
import { checkCommittedBuildSlots } from './commitIntegrity';
import type { BuildSlotCheck } from './types';

export { stripInheritedLaneEnv } from './laneBuildSlots';

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
