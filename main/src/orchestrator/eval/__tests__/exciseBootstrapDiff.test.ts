/**
 * Unit tests for excising the runbook bootstrap's files from an eval diff
 * (docs/proposals/lane-runbook-bootstrap.md §11).
 *
 * `snapshotRunForEval` already exempts the verify-setup flow from auto-eval, and
 * its stated reason is exact: that flow's diff is "a verification runbook plus
 * isolation levers whose real acceptance test is its own proof run". The
 * bootstrap moves that same diff class into sprint/ship runs, which ARE graded
 * and A/B-compared — so a project that happens to need a bootstrap would start
 * scoring differently for reasons unrelated to the work.
 *
 * The tests that matter most are the ones about NOT breaking a diff: this is a
 * section splitter, not a diff parser, and every case it cannot understand must
 * return the input untouched. Grading an un-excised diff is a small unfairness;
 * corrupting one would put a mangled diff in front of a judge and score the
 * result.
 */
import { describe, it, expect } from 'vitest';
import { exciseBootstrapDiff } from '../exciseBootstrapDiff';
import type { RunGitDiff } from '../../../../../shared/types/runFiles';

const RUNBOOK_PATH = '.cyboflow/verify-runbook.json';

const LANE_SECTION = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '+const b = 2;',
  '-const c = 3;',
].join('\n');

const RUNBOOK_SECTION = [
  `diff --git a/${RUNBOOK_PATH} b/${RUNBOOK_PATH}`,
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  `+++ b/${RUNBOOK_PATH}`,
  '@@ -0,0 +1,3 @@',
  '+{',
  '+  "version": 1',
  '+}',
].join('\n');

const CONFIG_SECTION = [
  'diff --git a/package.json b/package.json',
  'index 4444444..5555555 100644',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -3,6 +3,7 @@',
  '   "scripts": {',
  '+    "verify:serve": "vite preview"',
].join('\n');

const EMPTY_WORKTREE: RunGitDiff['worktree'] = {
  entries: [],
  groups: [
    { scope: 'unstaged', files: [], additions: 0, deletions: 0 },
    { scope: 'staged', files: [], additions: 0, deletions: 0 },
    { scope: 'untracked', files: [], additions: 0, deletions: 0 },
    { scope: 'committed', files: [], additions: 0, deletions: 0 },
  ],
  committedUnavailable: true,
};

function captured(sections: string[], stats: RunGitDiff['stats'], files: string[]): RunGitDiff {
  return { diff: sections.join('\n'), stats, changedFiles: files, resolvedBase: null, worktree: EMPTY_WORKTREE };
}

describe('exciseBootstrapDiff', () => {
  it('drops the runbook section and leaves the lane\'s work intact', () => {
    const input = captured(
      [LANE_SECTION, RUNBOOK_SECTION],
      { additions: 4, deletions: 1, filesChanged: 2 },
      ['src/app.ts', RUNBOOK_PATH],
    );
    const result = exciseBootstrapDiff(input, [RUNBOOK_PATH]);
    expect(result.diff).toContain('src/app.ts');
    expect(result.diff).not.toContain(RUNBOOK_PATH);
    expect(result.changedFiles).toEqual(['src/app.ts']);
  });

  it('subtracts the removed section\'s counts from the stats', () => {
    // Subtracted rather than recomputed: the captured stats are GIT's, and
    // re-deriving them would silently substitute this module's counting rules
    // for git's on every eval row — including the vast majority with nothing to
    // excise.
    const input = captured(
      [LANE_SECTION, RUNBOOK_SECTION],
      { additions: 4, deletions: 1, filesChanged: 2 },
      ['src/app.ts', RUNBOOK_PATH],
    );
    const result = exciseBootstrapDiff(input, [RUNBOOK_PATH]);
    expect(result.stats).toEqual({ additions: 1, deletions: 1, filesChanged: 1 });
  });

  it('drops BOTH the runbook and the rung-1 file when both were written', () => {
    const input = captured(
      [LANE_SECTION, CONFIG_SECTION, RUNBOOK_SECTION],
      { additions: 5, deletions: 1, filesChanged: 3 },
      ['src/app.ts', 'package.json', RUNBOOK_PATH],
    );
    const result = exciseBootstrapDiff(input, [RUNBOOK_PATH, 'package.json']);
    expect(result.diff).toContain('src/app.ts');
    expect(result.diff).not.toContain('package.json');
    expect(result.stats.filesChanged).toBe(1);
  });

  it('returns the input UNCHANGED when there is nothing to excise', () => {
    // By identity, so the common path — every run that did not bootstrap —
    // costs one scan and no allocation.
    const input = captured([LANE_SECTION], { additions: 1, deletions: 1, filesChanged: 1 }, ['src/app.ts']);
    expect(exciseBootstrapDiff(input, [RUNBOOK_PATH])).toBe(input);
    expect(exciseBootstrapDiff(input, [])).toBe(input);
  });

  it('returns the input unchanged for a diff it cannot section', () => {
    // A diff with no `diff --git` headers is not one this understands. Grading
    // it as captured is a small unfairness; guessing at its structure would put
    // a mangled diff in front of a judge.
    const input: RunGitDiff = {
      diff: 'something that is not a unified diff at all',
      stats: { additions: 0, deletions: 0, filesChanged: 0 },
      changedFiles: [],
      resolvedBase: null,
      worktree: EMPTY_WORKTREE,
    };
    expect(exciseBootstrapDiff(input, [RUNBOOK_PATH])).toBe(input);
  });

  it('returns the input unchanged for an empty diff', () => {
    const input: RunGitDiff = {
      diff: '',
      stats: { additions: 0, deletions: 0, filesChanged: 0 },
      changedFiles: [],
      resolvedBase: null,
      worktree: EMPTY_WORKTREE,
    };
    expect(exciseBootstrapDiff(input, [RUNBOOK_PATH])).toBe(input);
  });

  it('keeps a section whose path merely CONTAINS an excised name', () => {
    // `package.json.bak` is not `package.json`. Matched on the header's exact
    // paths rather than by substring, because over-excision here silently
    // deletes a lane's work from what a judge grades.
    const decoy = [
      'diff --git a/package.json.bak b/package.json.bak',
      '--- a/package.json.bak',
      '+++ b/package.json.bak',
      '@@ -1 +1 @@',
      '+x',
    ].join('\n');
    const input = captured([decoy], { additions: 1, deletions: 0, filesChanged: 1 }, ['package.json.bak']);
    expect(exciseBootstrapDiff(input, ['package.json'])).toBe(input);
  });

  it('never drives a count below zero', () => {
    // Defensive: the captured stats and the section text come from the same git
    // invocation, but a disagreement between them must not produce a negative
    // that a judge or a chart would then render.
    const input = captured([RUNBOOK_SECTION], { additions: 0, deletions: 0, filesChanged: 0 }, [RUNBOOK_PATH]);
    const result = exciseBootstrapDiff(input, [RUNBOOK_PATH]);
    expect(result.stats).toEqual({ additions: 0, deletions: 0, filesChanged: 0 });
  });

  it('does not count the `+++`/`---` file markers as added or removed lines', () => {
    const input = captured(
      [LANE_SECTION, RUNBOOK_SECTION],
      { additions: 4, deletions: 1, filesChanged: 2 },
      ['src/app.ts', RUNBOOK_PATH],
    );
    // The runbook section has 3 real `+` lines plus a `+++` marker; excising it
    // must remove 3, not 4.
    const result = exciseBootstrapDiff(input, [RUNBOOK_PATH]);
    expect(result.stats.additions).toBe(1);
  });

  it('preserves git\'s preamble, if the capture had one', () => {
    const input: RunGitDiff = {
      diff: `some preamble\n${RUNBOOK_SECTION}\n${LANE_SECTION}`,
      stats: { additions: 4, deletions: 1, filesChanged: 2 },
      changedFiles: ['src/app.ts', RUNBOOK_PATH],
      resolvedBase: null,
      worktree: EMPTY_WORKTREE,
    };
    const result = exciseBootstrapDiff(input, [RUNBOOK_PATH]);
    expect(result.diff.startsWith('some preamble')).toBe(true);
    expect(result.diff).toContain('src/app.ts');
  });
});
