/**
 * Pure helpers for the sprint fan-out's lane-end COMMIT-INTEGRITY check (see
 * `FanOutDriver.beginCommitProbe` and the controller's `checkCommitIntegrity`).
 * Kept free of git/DB so the probe (index.ts) and the controller share one
 * parser and one rendering of the evidence the monitor triages.
 */

import type { CommitIntegrityReading } from './types';

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
