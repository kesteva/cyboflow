/**
 * Removing the runbook bootstrap's own commits from a run's EVAL DIFF
 * (docs/proposals/lane-runbook-bootstrap.md §11).
 *
 * WHY THIS EXISTS AT ALL. `snapshotRunForEval` already exempts the verify-setup
 * flow from auto-eval, and its stated reason is precise: that flow's diff is "a
 * verification runbook plus isolation levers whose real acceptance test is its
 * own proof run". The bootstrap moves exactly that diff class into SPRINT and
 * SHIP runs — which are auto-eval'd, rubric-graded, and A/B-compared. Without
 * this, a run gets scored on machine-written JSON none of its agents authored,
 * and a project that happens to need a bootstrap starts scoring differently from
 * one that does not, for reasons that have nothing to do with the work.
 *
 * EXCISED BY PATH, and only the paths the bootstrap actually wrote: the runbook
 * (a constant) plus the one rung-1 file recorded on the stamp. Two properties
 * follow, and both are deliberate:
 *
 *   - The runbook path is exclusively bootstrap-owned by construction, so
 *     dropping it can never remove a lane's work. Nothing else writes it, and
 *     address-review is told not to touch it.
 *   - The rung-1 path is NOT exclusively owned — a lane may legitimately have
 *     edited `package.json` too. Dropping the whole section slightly OVER-
 *     excises there. That is the right direction to be wrong: the alternative is
 *     grading a run on a config line a machine wrote, and the excess is one file
 *     in a diff that otherwise spans the run's real work.
 *
 * NOT A DIFF PARSER. It splits on `diff --git` section headers, which is the one
 * structural fact about unified diff output that is stable across git versions
 * and options. It never rewrites hunks, never renumbers, and returns the input
 * unchanged whenever it cannot find what it was asked to remove — an eval diff
 * this cannot understand is graded as it always was, which is worse than
 * excising but far better than corrupting.
 */
import type { RunGitDiff } from '../../../../shared/types/runFiles';

/**
 * Split a unified diff into per-file sections, each starting at its own
 * `diff --git` line. Anything before the first header (git's own preamble, or an
 * empty string) is returned as the leader.
 */
function splitDiffSections(diff: string): { leader: string; sections: string[] } {
  const lines = diff.split('\n');
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) starts.push(i);
  }
  if (starts.length === 0) return { leader: diff, sections: [] };
  const leader = lines.slice(0, starts[0]).join('\n');
  const sections: string[] = [];
  for (let s = 0; s < starts.length; s += 1) {
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    sections.push(lines.slice(starts[s], end).join('\n'));
  }
  return { leader, sections };
}

/**
 * The paths a `diff --git a/X b/Y` header names. Both sides are returned because
 * a rename names two, and either matching is enough to identify the section.
 *
 * Quoted paths (git's `core.quotePath` form, used for non-ASCII names) are left
 * as-is: an unquoted comparison simply will not match, and a non-match means the
 * section is KEPT, which is the safe direction.
 */
function pathsInHeader(header: string): string[] {
  const match = /^diff --git a\/(.+?) b\/(.+?)$/.exec(header.split('\n')[0]);
  if (match === null) return [];
  return [match[1], match[2]];
}

/** Count `+`/`-` body lines in one section, ignoring the `+++`/`---` file markers. */
function countSectionStats(section: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of section.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Remove every section whose file is one of `paths`, adjusting the stats to
 * match.
 *
 * The stats are recomputed by SUBTRACTION rather than by re-deriving them from
 * the remaining text: the captured stats are git's own, and re-deriving would
 * silently substitute this module's counting rules for git's on every eval row,
 * including the vast majority that have nothing to excise. Subtracting only
 * touches the rows that actually changed.
 *
 * Returns the input object unchanged (by identity) when there is nothing to
 * remove, so the common path costs one scan and no allocation.
 */
export function exciseBootstrapDiff(captured: RunGitDiff, paths: readonly string[]): RunGitDiff {
  if (paths.length === 0 || captured.diff.length === 0) return captured;
  const excise = new Set(paths);

  const { leader, sections } = splitDiffSections(captured.diff);
  if (sections.length === 0) return captured;

  const kept: string[] = [];
  let removedAdditions = 0;
  let removedDeletions = 0;
  let removedFiles = 0;
  for (const section of sections) {
    const isBootstrap = pathsInHeader(section).some((p) => excise.has(p));
    if (!isBootstrap) {
      kept.push(section);
      continue;
    }
    const stats = countSectionStats(section);
    removedAdditions += stats.additions;
    removedDeletions += stats.deletions;
    removedFiles += 1;
  }
  if (removedFiles === 0) return captured;

  return {
    diff: [leader, ...kept].filter((part) => part.length > 0).join('\n'),
    stats: {
      additions: Math.max(0, captured.stats.additions - removedAdditions),
      deletions: Math.max(0, captured.stats.deletions - removedDeletions),
      filesChanged: Math.max(0, captured.stats.filesChanged - removedFiles),
    },
    changedFiles: captured.changedFiles.filter((file) => !excise.has(file)),
    // Same base as the un-excised capture — excising files never changes what
    // the diff was computed against (TASK-211).
    resolvedBase: captured.resolvedBase,
    // Filter membership the same way changedFiles is filtered above. Per-group
    // additions/deletions are NOT recomputed from the excised files (no
    // per-file breakdown is available in a DiffGroupRollup) — the same
    // "slightly over-counts, never corrupts" tradeoff this module already makes
    // for the rung-1 file (see module doc comment).
    worktree: {
      entries: captured.worktree.entries.filter((entry) => !excise.has(entry.path)),
      groups: captured.worktree.groups.map((group) => ({
        ...group,
        files: group.files.filter((file) => !excise.has(file)),
      })),
      committedUnavailable: captured.worktree.committedUnavailable,
    },
  };
}
