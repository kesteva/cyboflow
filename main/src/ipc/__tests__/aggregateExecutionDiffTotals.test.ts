/**
 * Unit tests for aggregateExecutionDiffTotals
 * (main/src/ipc/executionDiffAggregation.ts, TASK-086) — the
 * sessions:get-statistics running-card file-stats aggregation, colocated in
 * its own file (rather than inline in session.ts) so this suite can import
 * it directly without pulling in session.ts's full Electron-dependent
 * import graph.
 *
 * Root cause: ExecutionTracker.endExecution captures a diff against HEAD
 * (GitDiffManager.captureWorkingDirectoryDiff) whenever a turn does not
 * commit — since HEAD never advances across such turns, EVERY row in that
 * stretch reports the FULL CUMULATIVE diff since the last real commit, not
 * a per-turn delta. The pre-fix handler naively summed stats_additions /
 * stats_deletions / stats_files_changed across every row, multiplying the
 * true total by roughly the number of uncommitted turns.
 *
 * These tests lock the fixed aggregation: contiguous runs of rows sharing
 * the same before_commit_hash collapse to their LAST row's stats; runs
 * where before_commit_hash changes every row (real commit chains) sum
 * every row, unchanged from before.
 */
import { describe, it, expect } from 'vitest';
import { aggregateExecutionDiffTotals } from '../executionDiffAggregation';
import type { ExecutionDiffStats } from '../../database/database';

function row(
  overrides: Partial<ExecutionDiffStats> & { execution_sequence: number },
): ExecutionDiffStats {
  return {
    files_changed: [],
    stats_additions: 0,
    stats_deletions: 0,
    stats_files_changed: 0,
    before_commit_hash: null,
    after_commit_hash: null,
    ...overrides,
  };
}

describe('aggregateExecutionDiffTotals', () => {
  it('commit-disabled session: collapses a run of same-before_commit_hash cumulative rows to the LAST row\'s stats', () => {
    // Simulates 3 turns of a commitMode: 'disabled' session — HEAD (and thus
    // before_commit_hash) never advances, and each row's stats grow because
    // captureWorkingDirectoryDiff diffs against the same unchanged HEAD.
    const diffs: ExecutionDiffStats[] = [
      row({ execution_sequence: 1, files_changed: ['foo.ts'], stats_additions: 5, stats_deletions: 0, stats_files_changed: 1, before_commit_hash: 'headA' }),
      row({ execution_sequence: 2, files_changed: ['foo.ts'], stats_additions: 12, stats_deletions: 0, stats_files_changed: 1, before_commit_hash: 'headA' }),
      row({ execution_sequence: 3, files_changed: ['foo.ts', 'bar.ts'], stats_additions: 22, stats_deletions: 0, stats_files_changed: 2, before_commit_hash: 'headA' }),
    ];

    const result = aggregateExecutionDiffTotals(diffs);

    // Total equals the LAST row's stats, not the naive sum (5+12+22=39).
    expect(result.totalLinesAdded).toBe(22);
    expect(result.totalLinesDeleted).toBe(0);
    expect(result.totalFilesChanged).toBe(2);
    // File-dedup Set union is unchanged — still unions across ALL rows.
    expect(result.filesModified).toEqual(new Set(['foo.ts', 'bar.ts']));
  });

  it('auto-commit session: sums every row when before_commit_hash is a genuine per-turn chain', () => {
    // Simulates 3 turns of an auto-commit session — each turn's commit
    // advances HEAD, so before_commit_hash differs turn to turn and each
    // row's stats are a real, non-overlapping delta.
    const diffs: ExecutionDiffStats[] = [
      row({ execution_sequence: 1, files_changed: ['a.ts'], stats_additions: 5, stats_deletions: 1, stats_files_changed: 1, before_commit_hash: 'c0', after_commit_hash: 'c1' }),
      row({ execution_sequence: 2, files_changed: ['b.ts'], stats_additions: 7, stats_deletions: 2, stats_files_changed: 1, before_commit_hash: 'c1', after_commit_hash: 'c2' }),
      row({ execution_sequence: 3, files_changed: ['c.ts'], stats_additions: 3, stats_deletions: 0, stats_files_changed: 1, before_commit_hash: 'c2', after_commit_hash: 'c3' }),
    ];

    const result = aggregateExecutionDiffTotals(diffs);

    expect(result.totalLinesAdded).toBe(15); // 5 + 7 + 3
    expect(result.totalLinesDeleted).toBe(3); // 1 + 2 + 0
    expect(result.totalFilesChanged).toBe(3); // 1 + 1 + 1 (each its own run)
    expect(result.filesModified).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']));
  });

  it('mixed: a commit-chain segment followed by a run of uncommitted (same-hash) rows composes per-segment', () => {
    const diffs: ExecutionDiffStats[] = [
      // Segment 1: two real commits (each row its own singleton run).
      row({ execution_sequence: 1, files_changed: ['a.ts'], stats_additions: 4, stats_deletions: 0, stats_files_changed: 1, before_commit_hash: 'c0', after_commit_hash: 'c1' }),
      row({ execution_sequence: 2, files_changed: ['b.ts'], stats_additions: 6, stats_deletions: 1, stats_files_changed: 1, before_commit_hash: 'c1', after_commit_hash: 'c2' }),
      // Segment 2: commit mode flips to 'disabled' for the rest of the
      // session — 3 cumulative rows all diffing against c2 (unchanged HEAD).
      row({ execution_sequence: 3, files_changed: ['c.ts'], stats_additions: 2, stats_deletions: 0, stats_files_changed: 1, before_commit_hash: 'c2' }),
      row({ execution_sequence: 4, files_changed: ['c.ts', 'd.ts'], stats_additions: 9, stats_deletions: 1, stats_files_changed: 2, before_commit_hash: 'c2' }),
      row({ execution_sequence: 5, files_changed: ['c.ts', 'd.ts', 'e.ts'], stats_additions: 15, stats_deletions: 3, stats_files_changed: 3, before_commit_hash: 'c2' }),
    ];

    const result = aggregateExecutionDiffTotals(diffs);

    // Segment 1 sums (4+6=10), segment 2 collapses to its last row (15) —
    // total additions = 10 + 15 = 25, NOT the naive sum of all 5 rows (36).
    expect(result.totalLinesAdded).toBe(25);
    expect(result.totalLinesDeleted).toBe(1 + 3); // segment1 sum (0+1) + segment2 last (3)
    expect(result.totalFilesChanged).toBe(1 + 1 + 3); // seg1: 1,1 ; seg2 collapses to last row's 3
    expect(result.filesModified).toEqual(new Set(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']));
  });

  it('mixed: a run of uncommitted (same-hash) rows followed by a real commit-chain segment composes per-segment', () => {
    const diffs: ExecutionDiffStats[] = [
      // Segment 1: 2 cumulative disabled-commit rows against the same HEAD.
      row({ execution_sequence: 1, files_changed: ['a.ts'], stats_additions: 3, stats_deletions: 0, stats_files_changed: 1, before_commit_hash: 'c0' }),
      row({ execution_sequence: 2, files_changed: ['a.ts', 'b.ts'], stats_additions: 8, stats_deletions: 1, stats_files_changed: 2, before_commit_hash: 'c0' }),
      // Segment 2: session switches to a real commit — a genuine delta.
      row({ execution_sequence: 3, files_changed: ['c.ts'], stats_additions: 5, stats_deletions: 2, stats_files_changed: 1, before_commit_hash: 'c1', after_commit_hash: 'c2' }),
    ];

    const result = aggregateExecutionDiffTotals(diffs);

    // Segment 1 collapses to its last row (8), segment 2 adds its own (5) => 13.
    expect(result.totalLinesAdded).toBe(13);
    expect(result.totalLinesDeleted).toBe(1 + 2);
    expect(result.totalFilesChanged).toBe(2 + 1);
    expect(result.filesModified).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']));
  });

  it('treats null before_commit_hash as a normal grouping value (legacy rows pre-dating the column)', () => {
    const diffs: ExecutionDiffStats[] = [
      row({ execution_sequence: 1, stats_additions: 2, stats_files_changed: 1, before_commit_hash: null }),
      row({ execution_sequence: 2, stats_additions: 6, stats_files_changed: 2, before_commit_hash: null }),
    ];

    const result = aggregateExecutionDiffTotals(diffs);

    // Both nulls group into one run — collapses to the last row.
    expect(result.totalLinesAdded).toBe(6);
    expect(result.totalFilesChanged).toBe(2);
  });

  it('returns zeroed totals and empty set for an empty diffs array', () => {
    const result = aggregateExecutionDiffTotals([]);
    expect(result).toEqual({
      totalFilesChanged: 0,
      totalLinesAdded: 0,
      totalLinesDeleted: 0,
      filesModified: new Set(),
    });
  });

  it('a single row (any before_commit_hash) contributes its own stats', () => {
    const diffs: ExecutionDiffStats[] = [
      row({ execution_sequence: 1, files_changed: ['solo.ts'], stats_additions: 9, stats_deletions: 4, stats_files_changed: 1, before_commit_hash: 'headOnly' }),
    ];

    const result = aggregateExecutionDiffTotals(diffs);

    expect(result.totalLinesAdded).toBe(9);
    expect(result.totalLinesDeleted).toBe(4);
    expect(result.totalFilesChanged).toBe(1);
    expect(result.filesModified).toEqual(new Set(['solo.ts']));
  });
});
