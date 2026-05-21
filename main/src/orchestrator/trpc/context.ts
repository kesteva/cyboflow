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
import type { DatabaseLike } from '../types';

/**
 * Injectable dependencies for the tRPC context.
 *
 * All fields are optional so callers (and unit tests) that do not need a
 * particular capability can omit it — the factory supplies safe no-ops.
 */
export interface ContextDeps {
  /**
   * Callback that sets the macOS dock badge count.
   *
   * Injected from `main/src/index.ts` by passing a closure over
   * `dockBadgeService.setBadgeCount`. Keeping this as a plain callback (rather
   * than importing the service directly) preserves the standalone-typecheck
   * invariant: no 'electron' or 'main/src/services/*' import is needed here.
   */
  setDockBadge?: (count: number) => void;

  /**
   * Live database handle for the orchestrator's SQLite DB.
   *
   * Injected from `main/src/index.ts` via `makeDatabaseLike(databaseService)`.
   * Keeping this as the narrow `DatabaseLike` interface (rather than importing
   * the concrete DatabaseService) preserves the standalone-typecheck invariant:
   * no 'better-sqlite3' or 'main/src/services/*' import is needed here.
   *
   * Handlers must explicitly check `ctx.db` before use — `undefined` is the
   * intentional default so unit tests that do not need DB access can omit it.
   */
  db?: DatabaseLike;
}

/**
 * Creates the tRPC request context.
 *
 * @param deps - Optional injectable callbacks. Omitting a field uses a safe
 *   no-op so tests and future standalone-Node scenarios work without wiring
 *   the full Electron service graph.
 * @returns A context object carrying the auth principal and injected callbacks.
 *
 * @remarks v2 team-tier: replace `'local'` with a real session-token lookup.
 * The shape of this return value is what `protectedProcedure` asserts on — keep
 * `userId` as the canonical field name regardless of how it is populated.
 */
export function createContext(deps: ContextDeps = {}): {
  userId: 'local';
  setDockBadge: (count: number) => void;
  db?: DatabaseLike;
} {
  const { setDockBadge = (_count: number) => undefined, db } = deps;
  return { userId: 'local' as const, setDockBadge, db };
}

/** Shape of the tRPC context, inferred from `createContext`. */
export type Context = ReturnType<typeof createContext>;
