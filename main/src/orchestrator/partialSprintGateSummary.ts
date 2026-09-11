/**
 * partialSprintGateSummary — composes the enriched decision-item body for a
 * sprint/ship run's terminal `human-review` gate when the fan-out settled with
 * one or more INCOMPLETE lanes (Item 2).
 *
 * Why: the escalation already exists — an incomplete lane increments the
 * controller's incompleteCount, which skips the automated closing stages
 * (sprint-verify / sprint-review) and parks the run at the terminal human gate
 * (see workflowController `skipToHumanGate` and sprint.md's closing-stage gate).
 * But the gate that opens carried only the generic "a human decision is
 * required" body, so a human had to open the swimlane to learn WHICH lanes
 * failed and how far they got. This composes that per-lane picture into the gate
 * body itself.
 *
 * Two kinds of incomplete, reported as two kinds:
 *   - FAILED  — the lane executed and did not succeed. It has a step it died on
 *               and an attempt count.
 *   - BLOCKED — the lane NEVER STARTED, because a prerequisite did not finish.
 *               It has no failure of its own; what it has is the prerequisite
 *               that stranded it. Listing these as failures is how one real
 *               defect used to read as a whole-sprint collapse.
 *
 * Scope: this reads what is ALREADY persisted per lane at gate-open time — the
 * task ref/title, the inner step the lane died on (`current_step_id`), the
 * attempt count (`attempts`), and the lane's in-batch blocking prerequisites. It
 * does NOT surface each attempt's failure TEXT: the controller does not retain
 * per-attempt error text today (only the closure-local visual
 * `pendingLoopbackFeedback` + systemic error), so that richer detail is a
 * follow-up requiring a per-lane failure-text accumulator.
 *
 * Self-contained: direct SQL reads over sprint_batch_tasks (LEFT JOIN tasks) and
 * task_dependencies, matching HumanStepManager's own direct-DB style — no
 * SprintLaneStore import, so the standalone-typecheck invariant (no
 * electron/better-sqlite3/services) holds.
 */
import type { DatabaseLike } from './types';

interface IncompleteLaneRow {
  task_id: string;
  status: string;
  ref: string | null;
  title: string | null;
  current_step_id: string | null;
  attempts: number;
}

/**
 * Each never-started lane's in-batch blocking prerequisites, as display refs.
 *
 * A SEPARATE, fail-soft query on purpose: `task_dependencies` is not guaranteed
 * to exist (an older DB, a partially-migrated one, a test fixture), and a throw
 * there must cost the body its "waiting on" detail, never the whole body. The
 * SQL mirrors `SprintLaneStore.blockedByRefsForBatch` — in-batch prerequisites
 * that have not integrated, refs resolved fail-soft to the raw task id.
 */
function readBlockedByRefs(db: DatabaseLike, runId: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let rows: Array<{ blocked_task_id: string; prereq_ref: string }>;
  try {
    rows = db
      .prepare(
        `SELECT dep.task_id AS blocked_task_id,
                COALESCE(t.ref, dep.depends_on_task_id) AS prereq_ref
           FROM task_dependencies dep
           JOIN sprint_batch_tasks pre
             ON pre.batch_id = (SELECT batch_id FROM workflow_runs WHERE id = ?)
            AND pre.task_id = dep.depends_on_task_id
            AND pre.status != 'integrated'
           LEFT JOIN tasks t ON t.id = dep.depends_on_task_id
          WHERE dep.kind = 'blocking'
          ORDER BY dep.id ASC`,
      )
      .all(runId) as Array<{ blocked_task_id: string; prereq_ref: string }>;
  } catch {
    return map; // no task_dependencies table / read error → no refs, still a body
  }
  for (const row of rows) {
    const refs = map.get(row.blocked_task_id);
    if (refs) refs.push(row.prereq_ref);
    else map.set(row.blocked_task_id, [row.prereq_ref]);
  }
  return map;
}

/** `` `TASK-107` — Add chat panel `` , falling back to the opaque task id. */
function laneLabel(row: IncompleteLaneRow): string {
  if (!row.ref) return `\`${row.task_id}\``;
  return `\`${row.ref}\`${row.title ? ` — ${row.title}` : ''}`;
}

/** "2 failed lanes" / "1 failed lane" — the count with its noun, no bold. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Compose an enriched gate body for a run's terminal human gate, or return null
 * when the run has no batch OR no incomplete lanes (leaving the caller's generic
 * body unchanged). Fail-soft: any read error returns null (the gate still opens
 * with the generic body — surfacing must never block the escalation itself).
 *
 * `stepName` is the human-readable gate name (e.g. "Human review") woven into the
 * lead line so the body reads naturally regardless of the flow.
 */
export function composePartialSprintGateBody(
  db: DatabaseLike,
  runId: string,
  stepName: string,
): string | null {
  let rows: IncompleteLaneRow[];
  try {
    rows = db
      .prepare(
        `SELECT sbt.task_id AS task_id, sbt.status AS status,
                sbt.current_step_id AS current_step_id,
                sbt.attempts AS attempts, t.ref AS ref, t.title AS title
           FROM sprint_batch_tasks sbt
           LEFT JOIN tasks t ON t.id = sbt.task_id
          WHERE sbt.batch_id = (SELECT batch_id FROM workflow_runs WHERE id = ?)
            AND sbt.status IN ('failed', 'blocked')
          ORDER BY t.ref IS NULL, t.ref, sbt.task_id`,
      )
      .all(runId) as IncompleteLaneRow[];
  } catch {
    return null; // no batch table / read error → generic body
  }

  if (rows.length === 0) return null; // clean sprint (or non-sprint run) → generic body

  const failedRows = rows.filter((r) => r.status === 'failed');
  const blockedRows = rows.filter((r) => r.status === 'blocked');

  // The lead counts the two kinds separately — "3 failed" and "3 failed and 9
  // never started" are very different sprints, and the old body could not tell
  // them apart.
  const countPhrase =
    failedRows.length > 0 && blockedRows.length > 0
      ? `**${plural(failedRows.length, 'failed lane')}** and **${blockedRows.length} never started**`
      : failedRows.length > 0
        ? `**${plural(failedRows.length, 'failed lane')}**`
        : `**${plural(blockedRows.length, 'never-started lane')}**`;

  const lines: string[] = [
    `This sprint reached **${stepName}** with ${countPhrase} — its automated closing checks ` +
      `(full-suite verify + cross-task review) were skipped so you can decide what to do with ` +
      `the partial sprint first.`,
  ];

  if (failedRows.length > 0) {
    lines.push('', '**Failed lanes**');
    for (const r of failedRows) {
      const step = r.current_step_id ? `\`${r.current_step_id}\`` : 'an early step';
      // `attempts`: 0 = first pass (never re-delegated), >=2 once implement re-ran.
      // Present it as a human 1-based attempt count (a lane that failed on its first
      // pass reads "after 1 attempt", one that exhausted the 3× cap reads "3").
      const attemptCount = r.attempts >= 2 ? r.attempts : 1;
      lines.push(
        `- ${laneLabel(r)} — failed at ${step} after ${plural(attemptCount, 'attempt')}.`,
      );
    }
  }

  if (blockedRows.length > 0) {
    const blockedBy = readBlockedByRefs(db, runId);
    lines.push('', '**Never started**');
    for (const r of blockedRows) {
      const refs = blockedBy.get(r.task_id) ?? [];
      const waiting =
        refs.length > 0
          ? `waiting on ${refs.map((ref) => `\`${ref}\``).join(', ')}`
          : 'waiting on a prerequisite that did not finish';
      lines.push(`- ${laneLabel(r)} — never started, ${waiting}.`);
    }
  }

  lines.push(
    '',
    'Approve to seal the partial sprint (each failed lane\'s task returns to the backlog), or ' +
      'reject to end the run. To re-drive a failed lane with guidance, rewind the run to the ' +
      'execute step.',
  );
  return lines.join('\n');
}
