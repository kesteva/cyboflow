/**
 * Narrow interface contracts for Orchestrator dependencies.
 *
 * Standalone-typecheck invariant: this file must NOT import from
 * 'electron', 'better-sqlite3', 'fs', or any concrete service in
 * main/src/services/*. Only primitive types are allowed.
 */
import type { RunQueueRegistry } from './RunQueueRegistry';
import type { ClaudeManagerLike, PermissionServerLike } from './stuckDetector';

// ---------------------------------------------------------------------------
// DatabaseLike
// ---------------------------------------------------------------------------

/** A prepared statement stub sufficient for Orchestrator-level operations. */
export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * Minimal database surface required by the Orchestrator.
 * Intentionally narrow — enough to prepare statements and run transactions.
 * No better-sqlite3 import; the real DatabaseService satisfies this shape.
 */
export interface DatabaseLike {
  prepare(sql: string): PreparedStatement;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
}

// ---------------------------------------------------------------------------
// LoggerLike
// ---------------------------------------------------------------------------

/**
 * Minimal structured-log surface.
 * Any logger that exposes these four methods (e.g. pino, winston, console
 * wrappers, or a vitest spy) satisfies this interface.
 */
export interface LoggerLike {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// OrchestratorDeps
// ---------------------------------------------------------------------------

/**
 * All collaborators required by Orchestrator, assembled as a single
 * dependency bag for constructor injection.
 */
export interface OrchestratorDeps {
  db: DatabaseLike;
  logger: LoggerLike;
  runQueues: RunQueueRegistry;
  /**
   * Optional: narrow interface for querying whether a Claude SDK run is
   * active for a given run ID.  When provided, StuckDetector uses it to
   * classify orphan_pty stuck reasons.  When omitted, orphan_pty detection
   * is effectively disabled (hasActiveRunForId always returns true).
   */
  claudeManager?: ClaudeManagerLike;
  /**
   * Optional: narrow interface for querying whether a permission-socket
   * client is connected for a given run ID.  When omitted, stale_socket
   * classification is disabled with a one-time WARN logged.
   */
  permissionServer?: PermissionServerLike;
}

// Re-export narrow interfaces so callers that only need the interface shapes
// do not need to import from stuckDetector.ts directly.
export type { ClaudeManagerLike, PermissionServerLike };
