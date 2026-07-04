/**
 * runEntityOwnership — derives which backlog entities a workflow run "owns".
 *
 * Ownership model:
 *  - Owned ideas = the run's `workflow_runs.seed_idea_id` (the idea chosen or
 *    minted at planner launch) UNION every idea the run CREATED during execution
 *    (entity_events rows entity_type='idea', kind='created', run_id=?), de-duped.
 *    A seed idea may also appear among the run-created ideas; the Set collapses
 *    the overlap so it surfaces once.
 *  - Created tasks = every task the run created (entity_events entity_type='task',
 *    kind='created', run_id=?). There is no seed-task notion (seed_idea_id is the
 *    only run→entity link column), so this is purely the created-event projection.
 *
 * Fail-soft contract: a pre-migration-017 DB lacking workflow_runs.seed_idea_id,
 * a DB with no entity_events table, or any other thrown query MUST yield [] —
 * never a throw. Ownership is a derived/observational read; a missing column or
 * table degrades to "owns nothing", it does not crash the caller.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/* — it reaches
 * the DB only through the narrow DatabaseLike surface, mirroring
 * stepTransitionBridge.ts.
 */
import type { DatabaseLike } from './types';

/**
 * Distinct entity ids of `entityType` rows the given run CREATED, read from the
 * append-only entity_events log (kind='created'). Fail-soft: a missing
 * entity_events table or any thrown query yields [].
 */
function entityIdsCreatedByRun(
  db: DatabaseLike,
  runId: string,
  entityType: 'idea' | 'task' | 'epic',
): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT entity_id AS entityId
         FROM entity_events
         WHERE entity_type = ? AND kind = 'created' AND run_id = ?`,
      )
      .all(entityType, runId) as Array<{ entityId: unknown }>;
    return rows
      .map((r) => r.entityId)
      .filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/**
 * The idea ids a run owns: its `seed_idea_id` (if set) UNION the ideas it
 * created during the run, de-duped. Fail-soft — see file header contract.
 *
 * @param db    Narrow DatabaseLike interface.
 * @param runId The workflow_runs.id whose owned ideas to resolve.
 */
export function listRunOwnedIdeaIds(db: DatabaseLike, runId: string): string[] {
  const ownedIds = new Set<string>();

  // seed_idea_id read is wrapped in its OWN try/catch: a pre-migration-017 DB
  // lacking the column raises "no such column" and must degrade to "no seed",
  // not abort the run-created-ideas union below.
  try {
    const seedRow = db
      .prepare('SELECT seed_idea_id AS seedIdeaId FROM workflow_runs WHERE id = ?')
      .get(runId) as { seedIdeaId: unknown } | undefined;
    const seedIdeaId = seedRow?.seedIdeaId;
    if (typeof seedIdeaId === 'string' && seedIdeaId.length > 0) {
      ownedIds.add(seedIdeaId);
    }
  } catch {
    // Pre-migration-017 DB (no seed_idea_id column) — fall through.
  }

  for (const ideaId of entityIdsCreatedByRun(db, runId, 'idea')) {
    ownedIds.add(ideaId);
  }

  return [...ownedIds];
}

/**
 * The task ids a run created during execution. Fail-soft — see file header
 * contract.
 *
 * @param db    Narrow DatabaseLike interface.
 * @param runId The workflow_runs.id whose created tasks to resolve.
 */
export function listRunCreatedTaskIds(db: DatabaseLike, runId: string): string[] {
  return entityIdsCreatedByRun(db, runId, 'task');
}

/**
 * The epic ids a run created during execution. Fail-soft — see file header
 * contract. Mirrors listRunCreatedTaskIds; the approve-plan reveal stamps
 * approved_at on both the run's created tasks AND its created epics.
 *
 * @param db    Narrow DatabaseLike interface.
 * @param runId The workflow_runs.id whose created epics to resolve.
 */
export function listRunCreatedEpicIds(db: DatabaseLike, runId: string): string[] {
  return entityIdsCreatedByRun(db, runId, 'epic');
}

/**
 * The idea ids a run CREATED during execution (the run-created projection ONLY —
 * unlike {@link listRunOwnedIdeaIds}, this does NOT union the run's seed_idea_id).
 * Used by the experiment-arm sweep, which must delete only ideas the arm minted,
 * never the (orchestrator-created) injected seed clone — that is passed
 * explicitly. Fail-soft — see file header contract.
 */
export function listRunCreatedIdeaIds(db: DatabaseLike, runId: string): string[] {
  return entityIdsCreatedByRun(db, runId, 'idea');
}

/**
 * The idea id a run OPERATES ON when it does not own one directly. A standalone
 * sprint run has a null `seed_idea_id` and creates no ideas, so
 * listRunOwnedIdeaIds yields [] for it — but it still executes the tasks of an
 * idea's decomposition, linked via its sprint batch. This resolves that idea:
 *
 *   1. The DOMINANT idea across the run's sprint-batch tasks (`sprint_batch_tasks`
 *      JOIN `tasks`, picking the idea most tasks share).
 *   2. Failing that, the idea of the run's single `task_id`.
 *
 * A task reaches its idea EITHER directly (`tasks.originating_idea_id`, for a task
 * minted straight off an idea) OR through its parent epic
 * (`tasks.parent_epic_id` -> `epics.originating_idea_id`, for a task minted under
 * an epic — these carry a NULL originating_idea_id). Both queries COALESCE the two
 * so a batch of purely epic-child tasks still resolves.
 *
 * Returns null when neither resolves. Fail-soft: a pre-sprint-batch DB lacking
 * `sprint_batch_tasks` / `batch_id` / `task_id`, or any thrown query, degrades to
 * null (mirrors listRunOwnedIdeaIds — a missing table/column means "operates on
 * no resolvable idea", never a throw).
 *
 * @param db    Narrow DatabaseLike interface.
 * @param runId The workflow_runs.id whose operating idea to resolve.
 */
export function resolveRunBatchIdeaId(db: DatabaseLike, runId: string): string | null {
  // 1. Dominant idea across the run's sprint-batch tasks (direct or via epic).
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(t.originating_idea_id, e.originating_idea_id) AS ideaId, COUNT(*) AS n
           FROM workflow_runs r
           JOIN sprint_batch_tasks sbt ON sbt.batch_id = r.batch_id
           JOIN tasks t ON t.id = sbt.task_id
           LEFT JOIN epics e ON e.id = t.parent_epic_id
          WHERE r.id = ? AND COALESCE(t.originating_idea_id, e.originating_idea_id) IS NOT NULL
          GROUP BY COALESCE(t.originating_idea_id, e.originating_idea_id)
          ORDER BY n DESC
          LIMIT 1`,
      )
      .get(runId) as { ideaId: unknown } | undefined;
    if (row && typeof row.ideaId === 'string' && row.ideaId.length > 0) return row.ideaId;
  } catch {
    // No sprint_batch_tasks table / no batch_id column — fall through.
  }

  // 2. The idea of the run's single task_id (direct or via epic).
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(t.originating_idea_id, e.originating_idea_id) AS ideaId
           FROM workflow_runs r
           JOIN tasks t ON t.id = r.task_id
           LEFT JOIN epics e ON e.id = t.parent_epic_id
          WHERE r.id = ? AND COALESCE(t.originating_idea_id, e.originating_idea_id) IS NOT NULL`,
      )
      .get(runId) as { ideaId: unknown } | undefined;
    if (row && typeof row.ideaId === 'string' && row.ideaId.length > 0) return row.ideaId;
  } catch {
    // No task_id column — fall through.
  }

  return null;
}
