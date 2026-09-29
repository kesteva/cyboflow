/**
 * Helpers for the sprint fan-out's lane-end COMMIT-INTEGRITY check (see
 * `FanOutDriver.beginCommitProbe` and the controller's `checkCommitIntegrity`).
 * Kept free of git/DB/fs imports (the git queries and the on-disk check take
 * their runners injected) so the probe (index.ts) and the controller share one
 * parser and one rendering of the evidence the monitor triages.
 */

import type { BuildSlotCheck, CommitIntegrityReading } from './types';
import { LANE_BUILD_SLOTS_DIR, type GitExit } from './laneBuildSlots';

/** How many dirty paths the monitor's evidence lists before summarizing the rest. */
const MAX_LISTED_PATHS = 40;

/**
 * Parse `git status --porcelain` (v1) output into the set of paths it reports.
 * A rename/copy (`R  old -> new`) contributes its DESTINATION; C-style quoted
 * paths (git's escaping of unusual characters) are kept quoted, which is fine
 * for the set comparison the probe does — both readings quote identically.
 */
export function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.trim().length === 0 || line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    paths.push(arrow >= 0 ? rest.slice(arrow + 4) : rest);
  }
  return paths;
}

/**
 * Render a suspicious commit-integrity reading (HEAD did not move, tree dirty)
 * as the error excerpt the monitor's lane triage reads. States the ownership
 * question plainly: with sibling lanes in the same worktree, the dirt may not
 * be this lane's at all.
 */
export function commitIntegrityExcerpt(reading: CommitIntegrityReading, sharedWorktree: boolean): string {
  const newPaths = reading.newDirtyPaths ?? reading.dirtyPaths;
  const lines = [
    'Every inner step of this lane returned ok, but the lane made NO git commit (HEAD did not move since the lane started) and the worktree has uncommitted changes.',
    sharedWorktree
      ? 'OWNERSHIP IS AMBIGUOUS: other lanes of this sprint were running in the SAME worktree while this lane ran, so these changes may be a sibling lane\'s in-progress work rather than this lane\'s.'
      : 'No other lane was running in this worktree while this lane ran, so these changes were most likely left by this lane.',
  ];
  if (newPaths !== undefined && newPaths.length > 0) {
    const listed = newPaths.slice(0, MAX_LISTED_PATHS).map((p) => `- ${p}`);
    if (newPaths.length > MAX_LISTED_PATHS) listed.push(`- … and ${newPaths.length - MAX_LISTED_PATHS} more`);
    lines.push(
      '',
      reading.newDirtyPaths !== undefined
        ? 'Uncommitted paths that appeared while this lane ran:'
        : 'Uncommitted paths:',
      ...listed,
    );
  }
  return lines.join('\n');
}

/** The one path reported when git says build-slot files were committed but could not list them. */
export const COMMITTED_BUILD_SLOTS_UNLISTED = `${LANE_BUILD_SLOTS_DIR}/ (git reports committed files here but could not list them — likely too many)`;

/**
 * One read of the lane-end HEAD's COMMITTED TREE under {@link LANE_BUILD_SLOTS_DIR}
 * — lane build output that must never be committed. Resolves `unknown` when git
 * could not answer; the caller decides what that means.
 *
 * Two queries, because the likeliest leak is also the biggest: a force-add of
 * the whole directory commits every slot's DerivedData at once, and its path
 * list can overflow the git runner's output buffer. So PRESENCE is decided by a
 * non-recursive `git ls-tree` (at most the one top entry — nothing to overflow),
 * and only then are the names listed for the monitor's evidence. A listing that
 * fails or overflows still reports a (placeholder) path: git has already said
 * the files are there.
 */
async function readBuildSlotTree(git: (args: string[]) => Promise<GitExit>): Promise<BuildSlotCheck> {
  try {
    const presence = await git(['ls-tree', '--name-only', 'HEAD', '--', LANE_BUILD_SLOTS_DIR]);
    if (presence.exitCode !== 0) return { kind: 'unknown' };
    if (presence.stdout.trim().length === 0) return { kind: 'clean' };
  } catch {
    return { kind: 'unknown' };
  }
  let listed: string[] = [];
  try {
    const names = await git(['ls-tree', '-r', '--name-only', 'HEAD', '--', LANE_BUILD_SLOTS_DIR]);
    if (names.exitCode === 0) listed = names.stdout.split('\n').filter((line) => line.length > 0);
  } catch {
    // Too many to list (the output buffer overflowed) or git died mid-way.
  }
  return { kind: 'leak', paths: listed.length > 0 ? listed : [COMMITTED_BUILD_SLOTS_UNLISTED] };
}

/**
 * Does the lane-end HEAD's committed tree carry lane build output? Inspects the
 * END HEAD's tree unconditionally rather than diffing a lane-start..end range:
 * a range base lives only in memory and would be lost to an app restart, after
 * which a lane re-dispatched from an already-contaminated HEAD would integrate
 * over it. The cost is that a hit may predate this lane (a sibling's commit, a
 * pre-sprint leak) — the fix is the same either way, and nothing contaminated
 * may be merged. A later commit that removes the files clears it.
 *
 * `git` runs one git command in the lane's worktree, resolving for ANY exit code
 * (`runGitExit`); `pathExists` answers whether a worktree-relative path exists
 * on disk. TRI-STATE ({@link BuildSlotCheck}), fail-closed only when it matters:
 * a git read that could not answer is retried ONCE; if it still cannot, the
 * result is `unknown` only when {@link LANE_BUILD_SLOTS_DIR} exists on disk
 * (lanes built there, so something could have leaked) and `clean` when it does
 * not (nothing could have). Never throws — a `pathExists` that throws counts as
 * "exists".
 */
export async function checkCommittedBuildSlots(
  git: (args: string[]) => Promise<GitExit>,
  pathExists: (relPath: string) => boolean | Promise<boolean>,
): Promise<BuildSlotCheck> {
  const first = await readBuildSlotTree(git);
  if (first.kind !== 'unknown') return first;
  const second = await readBuildSlotTree(git);
  if (second.kind !== 'unknown') return second;
  let slotsInUse: boolean;
  try {
    slotsInUse = await pathExists(LANE_BUILD_SLOTS_DIR);
  } catch {
    slotsInUse = true;
  }
  return slotsInUse ? { kind: 'unknown' } : { kind: 'clean' };
}

/** How many committed build-slot paths the monitor's evidence lists. */
const MAX_LISTED_BUILD_SLOT_PATHS = 20;

/**
 * Render a lane whose lane-end committed tree carries build-slot files as the
 * error excerpt the monitor's lane triage reads. Unlike the dirty-tree case
 * there is no ownership question that could clear the lane — whoever committed
 * them, it cannot integrate over them — so the excerpt says plainly that
 * "accept" is not an option and names the fix.
 */
export function committedBuildSlotsExcerpt(paths: readonly string[], sharedWorktree: boolean): string {
  const root = `${LANE_BUILD_SLOTS_DIR}/`;
  const listed = paths.slice(0, MAX_LISTED_BUILD_SLOT_PATHS).map((p) => `- ${p}`);
  if (paths.length > MAX_LISTED_BUILD_SLOT_PATHS) {
    listed.push(`- … and ${paths.length - MAX_LISTED_BUILD_SLOT_PATHS} more`);
  }
  return [
    `Every inner step of this lane returned ok, but the committed tree at the lane-end HEAD contains files under \`${root}\`:`,
    ...listed,
    '',
    `\`${root}\` holds the sprint lanes' private build output and caches (DerivedData, module caches, …). It must NEVER be committed: it is machine-local, often huge, and would be merged into the project with the sprint.`,
    `FIX: \`git rm -r --cached -- ${LANE_BUILD_SLOTS_DIR}\`, then commit. The files stay on disk, and the worktree's local git exclude keeps them out of later commits.`,
    sharedWorktree
      ? 'OWNERSHIP: the check reads the whole committed tree, so these files may predate this lane, and other lanes of this sprint were running in the SAME worktree while it ran — a sibling lane (or a leak from before the sprint) may have committed them. The fix is the same whoever committed them, and this lane cannot integrate until it is made.'
      : 'OWNERSHIP: no other lane was running in this worktree while this lane ran, but the check reads the whole committed tree, so these files were either committed by this lane or already in HEAD when it started (an earlier run of this lane, a leak from before the sprint). The fix is the same either way, and this lane cannot integrate until it is made.',
    '',
    'THIS IS NOT AN UNCOMMITTED-CHANGES QUESTION, AND "accept" IS NOT AN OPTION: the lane cannot integrate while these files are committed, and an accept verdict fails it. Use "retry" with guidance to run the fix above (the lane is re-checked when the re-run ends), or "give_up".',
  ].join('\n');
}

/**
 * Render a lane whose build-slot check could NOT be answered (git failed twice)
 * while `.cyboflow/build-slots/` exists on disk — so lane build output might be
 * committed — as the monitor's error excerpt. Fail-closed like a leak: "accept"
 * is not an option; a retry re-runs the check at the re-run's end.
 */
export function unverifiedBuildSlotsExcerpt(): string {
  const root = `${LANE_BUILD_SLOTS_DIR}/`;
  return [
    `Every inner step of this lane returned ok, but git could not verify whether lane build output under \`${root}\` is committed at the lane-end HEAD (the check failed twice), and that directory exists on disk, so sprint lanes have been building there and something may have leaked into a commit.`,
    '',
    `\`${root}\` holds the sprint lanes' private build output and caches (DerivedData, module caches, …). It must NEVER be committed, so a lane cannot integrate until the check can confirm it is not.`,
    `TO CHECK: \`git ls-tree -r --name-only HEAD -- ${LANE_BUILD_SLOTS_DIR}\` must print nothing. If it lists files, FIX: \`git rm -r --cached -- ${LANE_BUILD_SLOTS_DIR}\`, then commit (the files stay on disk).`,
    '',
    'THIS IS NOT AN UNCOMMITTED-CHANGES QUESTION, AND "accept" IS NOT AN OPTION: an accept verdict fails the lane. Use "retry" (a rescue re-runs the lane and the check runs again when it ends — include the check above in the guidance, and the fix if needed), or "give_up".',
  ].join('\n');
}
