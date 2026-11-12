/**
 * Boot-time reads over remote (SSH) sessions for M2 recovery (bootRecovery.ts). READS ONLY: sessions are archived
 * through DatabaseService, session_merge_backs is written by MergeBackStore alone.
 *
 * Half-provisioned sessions: taskQueue writes the session row before RemoteCheckout.ensureSessionWorktree walks
 * bare_ready → base_pushed → remote_ready, and a failed walk archives the row itself. A crash or quit in between
 * leaves a session that was never announced as created, with no run, whose merge-back row is missing (the crash
 * came before its first write) or still in bare_ready / base_pushed. The task queue is in-memory, so at boot nothing
 * can be provisioning: such a row is an orphan. A session that reached remote_ready, or has a run, is never one.
 */
import type { DatabaseLike } from '../../../orchestrator/types';
import type { ResumeDeps } from './mergeBackService';

/** Ids of remote sessions a crash or quit left half-provisioned (see above). Call at boot only. */
export function findHalfProvisionedRemoteSessions(db: DatabaseLike): string[] {
  const rows = db.prepare(
    `SELECT s.id AS id FROM sessions s
       LEFT JOIN session_merge_backs m ON m.session_id = s.id
      WHERE s.host_id IS NOT NULL AND s.host_id != 'local'
        AND COALESCE(s.archived, 0) = 0
        AND (m.session_id IS NULL OR m.state IN ('bare_ready', 'base_pushed'))
        AND s.run_id IS NULL AND s.chat_run_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.session_id = s.id)
      ORDER BY s.id`,
  ).all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** The session facts MergeBackService.resumeAll asks for. */
export function remoteResumeReads(db: DatabaseLike): Required<Pick<ResumeDeps, 'isArchived' | 'runsCreatedSince'>> {
  return {
    // A session row that is gone counts as archived: nothing is left to work on its environment worktree.
    isArchived: (sessionId) => {
      const row = db.prepare('SELECT archived FROM sessions WHERE id = ?').get(sessionId) as { archived: unknown } | undefined;
      return row === undefined || Boolean(row.archived);
    },
    // julianday() reads both CURRENT_TIMESTAMP text and the ISO stamps MergeBackStore writes.
    runsCreatedSince: (sessionId, iso) => {
      const row = db.prepare(
        'SELECT COUNT(*) AS n FROM workflow_runs WHERE session_id = ? AND julianday(created_at) > julianday(?)',
      ).get(sessionId, iso) as { n: number } | undefined;
      return row?.n ?? 0;
    },
  };
}
