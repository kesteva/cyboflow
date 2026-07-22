import type { ExecutionDiffStats } from '../database/database';

/**
 * Aggregate execution_diffs stats for the sessions:get-statistics running
 * session card, deduping cumulative working-directory-diff rows (TASK-086).
 *
 * Root cause: ExecutionTracker.endExecution captures a diff against HEAD
 * (GitDiffManager.captureWorkingDirectoryDiff) whenever a turn does not
 * commit (commitMode 'disabled', including in-place sessions, or any turn
 * where no commit happened) — since HEAD never advances across such turns,
 * EVERY row in that stretch reports the FULL CUMULATIVE diff since the last
 * real commit, not a per-turn delta. Naively summing stats_additions /
 * stats_deletions / stats_files_changed across N such rows therefore
 * multiplies the true total by roughly N.
 *
 * By contrast, when a turn DOES commit (checkpoint/structured modes),
 * before_commit_hash for the next turn is the commit HEAD just advanced to
 * (captureCommitDiff), so consecutive rows form a genuine non-overlapping
 * chain and summing them is correct — this case must not regress.
 *
 * Algorithm: walk rows in execution_sequence order, grouping them into
 * contiguous "runs" of consecutive rows that share the same
 * before_commit_hash (a new run starts whenever before_commit_hash changes
 * from the previous row — i.e. whenever a real commit advanced HEAD). Only
 * the LAST row of each run contributes its stats_* to the total, since
 * earlier rows in a same-before_commit_hash run are cumulative subsets of
 * it. Totals are then summed across runs. A row with before_commit_hash
 * === null is treated like any other value for the "same run" comparison
 * (null === null groups together, same as any other equal hash) — this
 * keeps the comparison simple with no special-casing, and matches legacy
 * rows created before before_commit_hash was populated.
 *
 * files_changed dedup is UNCHANGED: it is a union of all rows' file lists
 * regardless of run — a union of subsets is already correct, since a file
 * touched during a cumulative run was genuinely touched.
 */
export function aggregateExecutionDiffTotals(diffs: ExecutionDiffStats[]): {
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  filesModified: Set<string>;
} {
  let totalFilesChanged = 0;
  let totalLinesAdded = 0;
  let totalLinesDeleted = 0;
  const filesModified = new Set<string>();

  for (let i = 0; i < diffs.length; i++) {
    // Union file lists across ALL rows regardless of run boundaries.
    for (const file of diffs[i].files_changed || []) {
      filesModified.add(file);
    }

    const isLastRowOfRun =
      i === diffs.length - 1 || diffs[i + 1].before_commit_hash !== diffs[i].before_commit_hash;
    if (isLastRowOfRun) {
      // Only the last row of a contiguous same-before_commit_hash run
      // contributes — for a commit-chain run (every row a new hash) each
      // row is its own singleton run and DOES contribute, preserving the
      // existing sum-across-commits behavior.
      const last = diffs[i];
      totalFilesChanged += last.stats_files_changed || 0;
      totalLinesAdded += last.stats_additions || 0;
      totalLinesDeleted += last.stats_deletions || 0;
    }
  }

  return { totalFilesChanged, totalLinesAdded, totalLinesDeleted, filesModified };
}
