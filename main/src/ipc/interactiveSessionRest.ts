/**
 * Rest an interactive (PTY) quick session that is LIVE BUT IDLE — a REPL that
 * was spawned with no turn to run.
 *
 * Every spawn used to start a turn (the briefing rode the positional prompt),
 * so the eager-spawn seams marked the session 'running' and the turn-end
 * rester in index.ts ('turn-end' → 'completed') brought it back. With the
 * briefing on the system prompt a fresh spawn starts NOTHING, and a 'running'
 * mark would strand the session showing "working" forever — only a turn-end
 * rests it, and there is no turn. The 'turn-start' seam marks it running the
 * moment the user actually types.
 *
 * The resting value is 'completed' via the DB seam, byte-identical to what the
 * turn-end rester writes — NOT `updateSession({ status: 'stopped' })`. 'stopped'
 * is what the Stop button writes, and the board labels it "stopped by you"
 * (quickSessionTriage.describeReadyState), which is false for a session nobody
 * has touched. 'completed' is what a fresh session rested at before this
 * change (the briefing turn's turn-end), so the board sees exactly the state it
 * always has. The high-level updateSession() cannot write it (it re-maps
 * 'completed' through mapSessionStatusToDbStatus and drops the
 * completed_unviewed edge), hence the direct db write + manual emit, mirroring
 * the rester.
 *
 * Standalone module (no imports FROM ipc/) so both ipc/session.ts and index.ts
 * can share it without a cycle — the same reason quickSessionBriefings.ts exists.
 */

/** The slice of SessionManager this needs; structural so tests can fake it. */
export interface IdleRestSessionManagerLike {
  db: { updateSession(sessionId: string, update: { status: 'completed' }): void };
  getSession(sessionId: string): unknown;
  emit(event: 'session-updated', session: unknown): unknown;
}

export function restInteractiveSessionIdle(
  sessionManager: IdleRestSessionManagerLike,
  sessionId: string,
): void {
  sessionManager.db.updateSession(sessionId, { status: 'completed' });
  const updated = sessionManager.getSession(sessionId);
  if (updated) sessionManager.emit('session-updated', updated);
}
