/**
 * tRPC context for the cyboflow orchestrator.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*.
 *
 * Auth-principal placeholder: in v1, every local desktop session runs as the
 * hard-coded userId `'local'`. The v2 team-tier swap replaces `'local'` with a
 * real principal derived from a session token — that requires only swapping out
 * this single file (or injecting a session resolver at server-init time).
 */

/**
 * Creates the tRPC request context.
 *
 * @returns A context object carrying the auth principal for this request.
 *
 * @remarks v2 team-tier: replace `'local'` with a real session-token lookup.
 * The shape of this return value is what `protectedProcedure` asserts on — keep
 * `userId` as the canonical field name regardless of how it is populated.
 */
export function createContext() {
  return { userId: 'local' as const };
}

/** Shape of the tRPC context, inferred from `createContext`. */
export type Context = ReturnType<typeof createContext>;
