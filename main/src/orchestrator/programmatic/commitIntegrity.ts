/**
 * Helpers for the sprint fan-out's lane-end COMMIT-INTEGRITY check (see
 * `FanOutDriver.beginCommitProbe` and the controller's `checkCommitIntegrity`).
 * Kept free of git/DB imports (the one git query takes its runner injected) so
 * the probe (index.ts) and the controller share one parser and one rendering of
 * the evidence the monitor triages.
 */

import type { CommitIntegrityReading } from './types';
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
 * The paths under {@link LANE_BUILD_SLOTS_DIR} — lane build output that must
 * never be committed — that the commits in `startHead..endHead` ADDED or CHANGED.
 * A TREE comparison, not a walk of the commits: a later commit in the range that
 * removes them again clears the report. Deletions are left out (`--diff-filter=d`),
 * so a lane that cleans up an earlier offender is not blamed for it; renames are
 * off so a moved-in file reads as the add it is, whatever the user's config.
 * `git` runs one git command in the lane's worktree, resolving for ANY exit code
 * (`runGitExit`).
 *
 * Two queries, because the likeliest leak is also the biggest: a force-add of
 * the whole directory commits every slot's DerivedData at once, and its path
 * list can overflow the git runner's output buffer. So PRESENCE is decided by
 * `git diff --quiet` (exit 1 = something there, 0 = nothing — no output to
 * overflow), and only then are the names listed for the monitor's evidence. A
 * listing that fails or overflows still reports a (placeholder) path: git has
 * already said the files are there.
 *
 * Resolves `[]` when the range is empty. Fail-soft: a presence check that git
 * could not answer resolves undefined ("could not tell"), which never blocks
 * integration on its own.
 */
export async function readCommittedBuildSlotPaths(
  git: (args: string[]) => Promise<GitExit>,
  startHead: string,
  endHead: string,
): Promise<string[] | undefined> {
  if (startHead === endHead) return [];
  const range = ['--no-renames', '--diff-filter=d', startHead, endHead, '--', LANE_BUILD_SLOTS_DIR];
  try {
    const presence = await git(['diff', '--quiet', ...range]);
    if (presence.exitCode === 0) return [];
    if (presence.exitCode !== 1) return undefined;
  } catch {
    return undefined;
  }
  let listed: string[] = [];
  try {
    const names = await git(['diff', '--name-only', ...range]);
    if (names.exitCode === 0) listed = names.stdout.split('\n').filter((line) => line.length > 0);
  } catch {
    // Too many to list (the output buffer overflowed) or git died mid-way.
  }
  return listed.length > 0 ? listed : [COMMITTED_BUILD_SLOTS_UNLISTED];
}

/** How many committed build-slot paths the monitor's evidence lists. */
const MAX_LISTED_BUILD_SLOT_PATHS = 20;

/**
 * Render a lane whose commits carry build-slot files as the error excerpt the
 * monitor's lane triage reads. Unlike the dirty-tree case there is no ownership
 * question that could clear the lane — whoever committed them, it cannot
 * integrate over them — so the excerpt says plainly that "accept" is not an
 * option and names the fix.
 */
export function committedBuildSlotsExcerpt(paths: readonly string[], sharedWorktree: boolean): string {
  const root = `${LANE_BUILD_SLOTS_DIR}/`;
  const listed = paths.slice(0, MAX_LISTED_BUILD_SLOT_PATHS).map((p) => `- ${p}`);
  if (paths.length > MAX_LISTED_BUILD_SLOT_PATHS) {
    listed.push(`- … and ${paths.length - MAX_LISTED_BUILD_SLOT_PATHS} more`);
  }
  return [
    `Every inner step of this lane returned ok, but the commits made while it ran (lane-start HEAD → lane-end HEAD) added or changed files under \`${root}\`:`,
    ...listed,
    '',
    `\`${root}\` holds the sprint lanes' private build output and caches (DerivedData, module caches, …). It must NEVER be committed: it is machine-local, often huge, and would be merged into the project with the sprint.`,
    `FIX: \`git rm -r --cached -- ${LANE_BUILD_SLOTS_DIR}\`, then commit. The files stay on disk, and the worktree's local git exclude keeps them out of later commits.`,
    sharedWorktree
      ? 'OWNERSHIP: other lanes of this sprint were running in the SAME worktree while this lane ran, so this range also contains their commits and a sibling lane may have committed these files. The fix is the same whoever committed them, and this lane cannot integrate until it is made.'
      : 'No other lane was running in this worktree while this lane ran, so these commits are this lane\'s.',
    '',
    'THIS IS NOT AN UNCOMMITTED-CHANGES QUESTION, AND "accept" IS NOT AN OPTION: the lane cannot integrate while these files are in its commits, and an accept verdict fails it. Use "retry" with guidance to run the fix above (the lane is re-checked when the re-run ends), or "give_up".',
  ].join('\n');
}
