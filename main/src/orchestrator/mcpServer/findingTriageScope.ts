/**
 * findingTriageScope — who may list and close which findings over MCP.
 *
 * Extracted from mcpQueryHandler (issue #19 size ratchet) when the guard grew a
 * fourth arm: a USER-DRIVEN CHAT may triage any finding in its own project.
 *
 * Why chats and not flow steps. The narrow arms exist because flow steps call
 * `cyboflow_resolve_finding` N times per run with ids the model transcribed
 * from a list — the router validates only (projectId, status='pending'), so an
 * unguarded mistyped id would silently close an unrelated run's finding. A chat
 * is different in kind: a human is steering it, and "triage the project's
 * finding backlog" is a request only a human makes. Without this arm that
 * request had no legitimate path at all — a chat could not even SEE another
 * session's findings, and the workaround in the wild was raw UPDATEs against
 * sessions.db, bypassing the ReviewItemRouter chokepoint entirely.
 *
 * "Chat" = the caller's run is a `__quick__` sentinel (chatSentinelProvider
 * binds every chat turn — quick session or a chat panel on a flow session — to
 * one). Flow runs keep the three narrow arms unchanged.
 *
 * Standalone-typecheck invariant: no electron, no better-sqlite3, no services.
 */
import type { DatabaseLike } from '../types';
import { QUICK_WORKFLOW_NAME } from '../workflowRegistry';
import { selectSessionRunScope } from '../sessionRunScope';

/**
 * True when `runId` is a chat sentinel (its workflow is `__quick__`). Fails
 * CLOSED — any read error or missing row answers false, so a broken lookup can
 * only ever narrow a caller back to the flow-run arms.
 */
export function isChatSentinelRun(db: DatabaseLike, runId: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT w.name AS name
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(runId) as { name?: unknown } | undefined;
    return row?.name === QUICK_WORKFLOW_NAME;
  } catch {
    return false;
  }
}

/**
 * Guard a resolve/dismiss target: it must be a `kind='finding'` row the caller
 * is entitled to close. Four disjoint entitlements:
 *
 *  - the run FILED it (`run_id = runId`) — sprint/ship's address-review closing
 *    out its own code-review findings;
 *  - a run in the caller's OWN SESSION filed it — a chat turn closing out the
 *    findings of the flow run it is sitting on (a chat's run id is the
 *    `__quick__` sentinel, never the run that filed them);
 *  - the run was SEEDED with it (`workflow_runs.seed_finding_ids`) — a compound
 *    run acting on findings a human selected from EARLIER runs;
 *  - the caller is a CHAT and the finding is in the caller's project — a human
 *    triaging the project backlog through a chat (see the file header).
 *
 * None of these relax the CALLER's liveness check in handleResolveFinding: a
 * chat resolves a settled run's finding without that run being revived.
 *
 * Anything else — a flow run reaching for another run's finding, a `decision`
 * gate, a `human_task`, a missing id — is refused rather than silently closed.
 * Read-only; the status transition stays the router's job.
 */
export function resolveFindingTargetScope(
  db: DatabaseLike,
  runId: string,
  reviewItemId: string,
): { ok: true } | { ok: false; error: string } {
  const row = db
    .prepare(`SELECT kind, run_id AS runId, project_id AS projectId FROM review_items WHERE id = ?`)
    .get(reviewItemId) as { kind?: string; runId?: string | null; projectId?: unknown } | undefined;

  // Keep the router's existing 'not_found' code for a missing id — agents and
  // tests already key on it; only the refusals get their own codes.
  if (row === undefined) return { ok: false, error: 'not_found' };
  if (row.kind !== 'finding') return { ok: false, error: 'not_a_finding' };
  if (row.runId === runId) return { ok: true };

  // Same-session arm. Checked before the seed arm because it is the common
  // case for a chat turn and needs no JSON parse.
  if (
    typeof row.runId === 'string' &&
    row.runId.length > 0 &&
    selectSessionRunScope(db, runId).includes(row.runId)
  ) {
    return { ok: true };
  }

  // Seeded arm: the compound path. Unparseable / absent seed json ⇒ no
  // entitlement (fail closed), since this guards a WRITE.
  const runRow = db
    .prepare('SELECT seed_finding_ids AS seedFindingIds, project_id AS projectId FROM workflow_runs WHERE id = ?')
    .get(runId) as { seedFindingIds?: unknown; projectId?: unknown } | undefined;
  const seedJson =
    typeof runRow?.seedFindingIds === 'string' && runRow.seedFindingIds.length > 0
      ? runRow.seedFindingIds
      : null;
  if (seedJson !== null) {
    try {
      const parsed: unknown = JSON.parse(seedJson);
      if (Array.isArray(parsed) && parsed.includes(reviewItemId)) return { ok: true };
    } catch {
      // fall through
    }
  }

  // Project arm: chats only, and never across projects.
  if (
    runRow !== undefined &&
    Number(runRow.projectId) === Number(row.projectId) &&
    isChatSentinelRun(db, runId)
  ) {
    return { ok: true };
  }
  return { ok: false, error: 'finding_not_in_run_scope' };
}
