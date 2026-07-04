/**
 * runFrozenSpec — resolve the FROZEN workflow spec a run executed against.
 *
 * A run stamps `spec_hash` at createRun from its EFFECTIVE spec (the variant's
 * frozen spec_json for a variant run, else the live workflow spec_json) and
 * INSERT-OR-IGNOREs a `workflow_revisions` row for it in the SAME transaction. So
 * the pair `(workflow_id, spec_hash)` always resolves to the exact spec text the
 * run should walk — even after the live `workflows.spec_json` is edited mid-run,
 * and even for a variant whose spec differs from the workflow's current one.
 *
 * The six per-run "effective definition" readers call this instead of reading the
 * live `workflows.spec_json` (the historical behaviour, which had a latent bug:
 * editing a workflow mid-run changed the running definition). Fail-soft: a missing
 * revision row FALLS BACK to the live `workflows.spec_json`, so every legacy /
 * baseline run is byte-identical to before this helper existed.
 *
 * Standalone-typecheck invariant: reads through the narrow DatabaseLike surface
 * only — no 'electron' / 'better-sqlite3' import, no logger dependency.
 */
import type { DatabaseLike } from './types';

/**
 * True only for SQLite "schema absence" errors — a missing table or column. These
 * are the ONLY expected failures of the reads below (a DB predating migration
 * 026/046 lacks the `spec_hash` column / `workflow_revisions` table; a minimal test
 * DB may lack `workflows`/`workflow_runs` entirely) and are the documented
 * degrade-to-fallback path. Any OTHER error (lock/I-O/corruption) means the DB is
 * genuinely broken — the caller must see it, not a misleading run-not-found / live-
 * spec fallback, so those are rethrown.
 */
function isSchemaAbsenceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return lower.includes('no such table') || lower.includes('no such column');
}

/**
 * Resolve a run's frozen workflow name + spec_json.
 *
 * @returns `{ workflowName, specJson }` where `specJson` is the revision text for
 *   the run's `(workflow_id, spec_hash)`, falling back to the live
 *   `workflows.spec_json` when no revision row exists (or the run had no
 *   spec_hash). Returns `null` when the run row is missing entirely.
 */
export function resolveRunFrozenSpec(
  db: DatabaseLike,
  runId: string,
): { workflowName: string; specJson: string | null } | null {
  // Base read uses ONLY always-present columns (name + live spec_json), so this
  // resolves even on a DB predating migration 026/046 (spec_hash / revisions). A
  // schema-ABSENCE failure (e.g. a minimal test DB with no `workflows` table) returns
  // null → the caller falls back to its own live workflow row / skips. Any OTHER
  // error (transient lock / I-O / corruption) is rethrown rather than masked as a
  // missing run, so a genuinely broken DB surfaces instead of silently mis-rendering.
  let runRow:
    | { workflowName?: unknown; liveSpecJson?: unknown; workflowId?: unknown }
    | undefined;
  try {
    runRow = db
      .prepare(
        `SELECT w.name AS workflowName, w.spec_json AS liveSpecJson, r.workflow_id AS workflowId
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(runId) as
      | { workflowName?: unknown; liveSpecJson?: unknown; workflowId?: unknown }
      | undefined;
  } catch (err) {
    // Schema absence (no workflows/workflow_runs table) → the documented
    // degrade-to-not-found path. A genuine transient/systemic error is rethrown so
    // it surfaces instead of masquerading as a missing run row.
    if (isSchemaAbsenceError(err)) return null;
    throw err;
  }

  if (!runRow || typeof runRow.workflowName !== 'string' || typeof runRow.workflowId !== 'string') {
    return null;
  }

  const workflowName = runRow.workflowName;
  const workflowId = runRow.workflowId;
  const liveSpecJson = typeof runRow.liveSpecJson === 'string' ? runRow.liveSpecJson : null;

  // Frozen-hash lookup is fail-soft at the SCHEMA level: a DB without the
  // spec_hash column (pre-026) or without the workflow_revisions table degrades to
  // the live spec — the documented "legacy/baseline run byte-identical" contract.
  let specHash: string | null = null;
  try {
    const hashRow = db
      .prepare('SELECT spec_hash AS specHash FROM workflow_runs WHERE id = ?')
      .get(runId) as { specHash?: unknown } | undefined;
    specHash = typeof hashRow?.specHash === 'string' ? hashRow.specHash : null;
  } catch (err) {
    // Missing spec_hash column (pre-026 DB) → degrade to the live spec. Any other
    // error is genuine and rethrown.
    if (isSchemaAbsenceError(err)) return { workflowName, specJson: liveSpecJson };
    throw err;
  }
  if (specHash === null) {
    return { workflowName, specJson: liveSpecJson };
  }

  let revisionSpecJson: string | null = null;
  try {
    const revision = db
      .prepare(
        `SELECT spec_json AS specJson
           FROM workflow_revisions
          WHERE workflow_id = ? AND spec_hash = ?`,
      )
      .get(workflowId, specHash) as { specJson?: unknown } | undefined;
    revisionSpecJson = typeof revision?.specJson === 'string' ? revision.specJson : null;
  } catch (err) {
    // Missing workflow_revisions table (pre-026 DB) → degrade to the live spec. Any
    // other error is genuine and rethrown.
    if (isSchemaAbsenceError(err)) return { workflowName, specJson: liveSpecJson };
    throw err;
  }

  // Revision present → the frozen spec; absent → fall back to the live spec.
  return { workflowName, specJson: revisionSpecJson ?? liveSpecJson };
}
