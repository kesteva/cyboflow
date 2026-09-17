/**
 * buildBreakDetector — spot the moment N lanes of one sprint are all reporting
 * the SAME broken tree, and say so once.
 *
 * THE SHAPE OF THE PROBLEM. Lanes share ONE worktree. When someone's commit (or
 * a half-finished sibling's edit) breaks the build, every lane that reaches a
 * compile or a test runner hits the identical error, works around it or burns
 * its attempt budget, and — under the build-break contract the step prompts now
 * carry — files a `cyboflow_report_finding` with `category: 'build-break'` and
 * the first error line as its title. Sixteen lanes produce sixteen cards that a
 * human has to read individually to notice they are one fact.
 *
 * WHAT THIS IS AND IS NOT. A DETECTOR. It groups those reports and hands the
 * controller a group to file ONE advisory card against. It does not pause the
 * run, does not deploy a fix agent, and does not own the tree. Those were
 * deliberately deferred: an autonomous tree-fix commits into the shared
 * worktree mid-lane, which interacts with the commit-integrity probe and the
 * eval diff in ways that need their own design pass.
 *
 * WHY NOT A LANE-SETTLE SWEEP. `cyboflow_report_finding` validates
 * synchronously and then replies `ok:true` WITHOUT awaiting the
 * ReviewItemRouter's per-project queue, so a lane's own finding may commit after
 * that lane has settled. With two lanes, the second lane's finding is exactly
 * the one the threshold needs and exactly the one most likely to be missing.
 * The controller therefore sweeps at the dispatch pool's QUIESCED instant
 * (nothing in flight) and once more at fan-out end, by which point the queue has
 * drained.
 *
 * WHY `json_extract`. `review_items` has no `category` column — `category` is a
 * member of the JSON `FindingPayload` (`shared/types/reviews.ts`), free text with
 * no constraint. The contract that makes `'build-break'` mean anything is prompt
 * text, not schema.
 */
import type { DatabaseLike } from '../types';
import type { BuildBreakGroup } from './types';

export type { BuildBreakGroup };

/** A group counts as a shared break at this many distinct findings. */
export const BUILD_BREAK_GROUP_MIN = 2;

/**
 * Reduce a build-break title to the text that is the SAME across lanes.
 *
 * A compiler or bundler error carries three kinds of per-lane noise, and all
 * three defeat a byte-identical comparison:
 *   - PATHS. Lanes share a worktree, so the FILE is actually the same — but a
 *     title composed from a repo-relative path in one lane and an absolute one
 *     in another still differs byte for byte. Every multi-segment path (POSIX or
 *     Windows, absolute or relative) is reduced to its last segment.
 *   - POSITIONS. `:12:4`, `(12,4)` and the like move as the file is edited
 *     under the lanes' feet. Stripped.
 *   - HEX IDS. Build hashes, chunk ids, request ids — anything 7+ hex digits.
 *     Stripped.
 * Then whitespace is collapsed and the result lowercased. The ORIGINAL title is
 * kept on the group (`sampleTitle`) so the human sees real text.
 *
 * Deliberately conservative: it never strips words, numbers that are not
 * positions, or quoted symbols, so two genuinely different breaks cannot fuse.
 * The failure mode it prefers is two groups for one break (two advisory cards),
 * never one group for two breaks (a card naming the wrong thing).
 */
export function normalizeBuildBreak(title: string): string {
  let text = title;
  // Any multi-segment path — absolute, relative, POSIX or Windows — collapses to
  // its LAST segment. Matching only absolute paths was not enough: the
  // interesting pair is an absolute path from one lane against a repo-relative
  // one from another, and a leading-separator-only rule turns `src/a.ts` into
  // `srca.ts` instead of `a.ts`. Run BEFORE the position strip so a Windows
  // drive letter's colon is not mistaken for a `:line` separator.
  text = text.replace(/(?:[A-Za-z]:)?[\w.@+~-]*(?:[/\\][\w.@+~-]+)+/g, (match) => {
    const segments = match.split(/[/\\]/);
    return segments[segments.length - 1];
  });
  // `:line:col` and `:line`, then `(line,col)` / `(line:col)`.
  text = text.replace(/:\d+(?::\d+)?\b/g, '');
  text = text.replace(/\(\s*\d+\s*[,:]\s*\d+\s*\)/g, '');
  // Long hex runs (build hashes, chunk + request ids). Word-bounded so ordinary
  // decimal counts ("4 errors") and short words survive.
  text = text.replace(/\b[0-9a-f]{7,}\b/gi, '');
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A short, stable, filename-safe key for a group's normalized text — the dedupe
 * `source` a group's advisory finding is filed under.
 *
 * FNV-1a, because the normalized text is arbitrary compiler output: it can be
 * long, and it can contain quotes, colons and newlines that have no business in
 * a `source` column that other code pattern-matches on. A hash collision would
 * merely suppress a second group's card, which is the same failure mode as a
 * normalizer that fused two breaks — bounded, and visible in the lane findings.
 */
export function buildBreakGroupKey(normalized: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** One pending build-break finding, as read from `review_items`. */
interface BuildBreakRow {
  id: string;
  title: string | null;
  entityType: string | null;
  entityId: string | null;
}

/**
 * Read this run's PENDING `build-break` findings and return the groups at least
 * {@link BUILD_BREAK_GROUP_MIN} of them share, newest grouping order preserved
 * (first-seen normalized text first).
 *
 * Read-only and fail-soft: any query error yields an empty list. A run whose
 * agents filed nothing, or whose findings a human already resolved, yields the
 * same empty list — `status = 'pending'` is deliberate, so a group a human has
 * already dealt with is not re-announced on the next sweep.
 *
 * GROUPING CAVEAT (documented on {@link BuildBreakGroup}): the threshold counts
 * DISTINCT REVIEW ITEMS, not distinct lanes. `cyboflow_report_finding` stamps
 * `source` as `agent:<step label>` — every lane's implement turn files as
 * `agent:implement` — and the build-break contract asks for no entity link, so
 * the row carries no lane identity. `laneRefs` recovers what it can from rows
 * that DID carry an `entity_type = 'task'` link and is frequently empty.
 */
export function sweepBuildBreaks(
  db: DatabaseLike,
  args: { runId: string; projectId: number },
): BuildBreakGroup[] {
  let rows: BuildBreakRow[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, title, entity_type AS entityType, entity_id AS entityId
           FROM review_items
          WHERE run_id = ?
            AND project_id = ?
            AND kind = 'finding'
            AND status = 'pending'
            AND json_extract(payload_json, '$.category') = 'build-break'
          ORDER BY created_at ASC`,
      )
      .all(args.runId, args.projectId) as BuildBreakRow[];
  } catch {
    return [];
  }

  const groups = new Map<string, BuildBreakGroup>();
  for (const row of rows) {
    const title = typeof row.title === 'string' ? row.title : '';
    const normalized = normalizeBuildBreak(title);
    if (normalized.length === 0) continue;
    const group = groups.get(normalized) ?? {
      normalized,
      itemIds: [],
      count: 0,
      laneRefs: [],
      sampleTitle: title,
    };
    if (!group.itemIds.includes(row.id)) {
      group.itemIds.push(row.id);
      group.count = group.itemIds.length;
    }
    if (row.entityType === 'task' && typeof row.entityId === 'string' && row.entityId.length > 0) {
      if (!group.laneRefs.includes(row.entityId)) group.laneRefs.push(row.entityId);
    }
    groups.set(normalized, group);
  }

  return [...groups.values()].filter((g) => g.count >= BUILD_BREAK_GROUP_MIN);
}
