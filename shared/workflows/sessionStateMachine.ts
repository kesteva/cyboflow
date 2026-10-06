/**
 * The `sessions.status` column's vocabulary.
 *
 * Declared HERE rather than imported because `shared/` may not reach into
 * `main/`, and this is the layer both the funnel (main/src/database) and any
 * future non-Electron host can see. It must stay identical to the inline union
 * on `Session['status']` in `main/src/database/models.ts`; the parity is pinned
 * by a type-level assertion in
 * `main/src/database/__tests__/sessionStateMachine.test.ts`, which is the only
 * place that can see both declarations.
 *
 * NOT the same as the RICHER app-level status union in `main/src/types/session.ts`
 * ('initializing' | 'ready' | 'running' | 'waiting' | 'stopped' |
 * 'completed_unviewed' | 'error'), which `SessionManager.mapSessionStatusToDbStatus`
 * collapses onto these five before the funnel ever sees it.
 */
export type SessionStatus = 'pending' | 'running' | 'stopped' | 'completed' | 'failed';

/**
 * Allowed transitions for `sessions.status`, the sibling of
 * {@link ../workflows/runStateMachine ALLOWED_TRANSITIONS} for the OTHER status
 * column with a single write funnel (`DatabaseService.updateSession`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS TABLE IS TOTAL, AND WHY THAT IS THE HONEST ANSWER
 * ─────────────────────────────────────────────────────────────────────────────
 * A workflow RUN has terminal states, so its table has real holes. A SESSION has
 * none: it is a long-lived chat vehicle that comes to rest and is woken again by
 * the next turn, for as long as the user keeps it. The graph was derived by
 * enumerating every `updateSession` caller in main/src (see the report that
 * accompanied this change) and it came back complete. The three families that
 * make it complete:
 *
 *   1. WAKE — every resting status re-enters `running` on a follow-up turn.
 *      `sessions:input`, the PTY dispatch rest seam and the boot resume all
 *      write `{ status: 'running' }` without consulting the status they are
 *      leaving (ipc/session.ts, ipc/ptyPanelDispatch.ts,
 *      index.ts). So {pending, stopped, completed, failed} -> running are all live.
 *
 *   2. RE-INIT — `sessions:continue-conversation` writes `'initializing'`, which
 *      SessionManager.mapSessionStatusToDbStatus maps to `pending`, from whatever
 *      status the session currently holds (ipc/session.ts). So `pending` is a
 *      RE-ENTRABLE state, not just the state the INSERT stamps.
 *
 *   3. REVERT — the two spawn-failure paths capture the pre-turn status and write
 *      it back verbatim after the optimistic `running` flip fails
 *      (`priorStatus` and `flippedFromStatus`, ipc/session.ts). Whatever a session
 *      can be, `running` can be restored to.
 *
 * Together those three cover every ordered pair, self-edges included (a turn-end
 * writer re-stamps `completed` on an already-`completed` session; the wake path
 * re-stamps `running` mid-turn). Narrowing any edge on taste rather than evidence
 * would break a live flow, so nothing is narrowed here.
 *
 * The table therefore earns its keep on the OTHER axis: it pins the status
 * VOCABULARY at the funnel. `sessions.status` has no CHECK constraint, and at
 * least one seam types the field as a bare `string`
 * (`main/src/ipc/ptyPanelDispatch.ts`'s structural `updateSession` dep), so a
 * value outside the union reaches the column with nothing to stop it. A session
 * stamped with a status no reader knows disappears from every status-filtered
 * query — `getActiveSessions`, the boot sweep, the board's idle derivation — and
 * looks like a lost session rather than a bad write.
 *
 * If a future change makes a session status genuinely terminal, this is the one
 * place to say so, and the funnel already enforces whatever it says.
 */
export const SESSION_ALLOWED_TRANSITIONS: Record<
  SessionStatus,
  readonly SessionStatus[]
> = {
  pending:   ['pending', 'running', 'stopped', 'completed', 'failed'],
  running:   ['pending', 'running', 'stopped', 'completed', 'failed'],
  stopped:   ['pending', 'running', 'stopped', 'completed', 'failed'],
  completed: ['pending', 'running', 'stopped', 'completed', 'failed'],
  failed:    ['pending', 'running', 'stopped', 'completed', 'failed'],
};

/** Every status the column accepts, derived from the table so the two agree. */
export const SESSION_STATUSES: readonly SessionStatus[] = Object.keys(
  SESSION_ALLOWED_TRANSITIONS,
) as SessionStatus[];

const SESSION_STATUS_SET: ReadonlySet<string> = new Set<string>(SESSION_STATUSES);

/** Narrowing predicate for a value arriving from an untyped seam. */
export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && SESSION_STATUS_SET.has(value);
}

/**
 * Pure predicate: is the (from -> to) session transition allowed?
 * `false` for any status outside the union at EITHER end — that is the check
 * this table exists to perform (see the doc comment above).
 */
export function isSessionTransitionAllowed(from: unknown, to: unknown): boolean {
  if (!isSessionStatus(from) || !isSessionStatus(to)) return false;
  return SESSION_ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Typed error for an illegal session transition. Thrown only in dev/test — the
 * production funnel logs and proceeds (see `DatabaseService.updateSession`).
 */
export class IllegalSessionTransitionError extends Error {
  public readonly from: string;
  public readonly to: string;
  public readonly sessionId: string | undefined;

  constructor(from: string, to: string, sessionId?: string) {
    const suffix = sessionId !== undefined ? ` (sessionId=${sessionId})` : '';
    super(`Illegal session status transition: ${from} -> ${to}${suffix}`);
    this.name = 'IllegalSessionTransitionError';
    this.from = from;
    this.to = to;
    this.sessionId = sessionId;
  }
}
