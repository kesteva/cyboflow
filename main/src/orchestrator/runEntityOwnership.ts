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
  entityType: 'idea' | 'task',
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
