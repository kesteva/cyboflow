/**
 * Shared dbAdapter test fixture — wraps a better-sqlite3 Database so it
 * satisfies the orchestrator's DatabaseLike interface. The compile-time
 * `: DatabaseLike` return type ensures any future widening of DatabaseLike
 * fails the build here, not in 4 silently-drifting test copies.
 */
import type Database from 'better-sqlite3';
import type { DatabaseLike } from '../types';

export function dbAdapter(db: Database.Database): DatabaseLike {
  return {
    prepare: (sql: string) => db.prepare(sql),
    transaction: <T>(fn: (...args: unknown[]) => T) =>
      db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
  };
}
