/**
 * makeLoggerLike — builds a LoggerLike from an optional Logger instance.
 *
 * Moved from main/src/ipc/cyboflow.ts so it can be imported by both
 * main/src/index.ts (AppServices assembly) and any other bootstrap code
 * that needs a LoggerLike without pulling in the full IPC module.
 *
 * The Logger class exposes info/warn/error but not debug, and its signatures
 * only accept (message: string, error?: Error).  This adapter wraps it to
 * satisfy LoggerLike.  When no Logger is provided a console-based shim is
 * returned so callers never receive null.
 */
import type { LoggerLike } from './types';
import type { Logger } from '../utils/logger';

/**
 * Build a LoggerLike from an optional Logger instance.
 * Falls back to a console-based shim when `logger` is undefined or null.
 */
export function makeLoggerLike(logger?: Logger): LoggerLike {
  if (!logger) {
    return {
      info:  (msg: string, ctx?: Record<string, unknown>) => console.info(msg, ctx ?? ''),
      warn:  (msg: string, ctx?: Record<string, unknown>) => console.warn(msg, ctx ?? ''),
      error: (msg: string, ctx?: Record<string, unknown>) => console.error(msg, ctx ?? ''),
      debug: (msg: string, ctx?: Record<string, unknown>) => console.debug(msg, ctx ?? ''),
    };
  }
  // The Logger class exposes info/warn/error but not debug, and its signatures
  // only accept (message: string, error?: Error).  Wrap to satisfy LoggerLike.
  // Stringify the optional context and append it to the message so callers
  // that pass { path, error, ... } bags don't silently lose those fields.
  return {
    info:  (msg: string, ctx?: Record<string, unknown>) => logger.info(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    warn:  (msg: string, ctx?: Record<string, unknown>) => logger.warn(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    error: (msg: string, ctx?: Record<string, unknown>) => logger.error(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
    debug: (msg: string, ctx?: Record<string, unknown>) => console.debug(ctx ? `${msg} ${JSON.stringify(ctx)}` : msg),
  };
}

/**
 * Build a DatabaseLike adapter from a databaseService-like object.  Mirrors
 * the inline pattern previously duplicated in main/src/index.ts for the
 * cyboflow services bootstrap and the tRPC orchestrator bootstrap.
 *
 * The structural-typed `databaseService` param keeps this module's
 * standalone-typecheck invariant intact (no import from
 * main/src/services/database).
 */
import type { DatabaseLike } from './types';

export function makeDatabaseLike(databaseService: {
  getDb: () => {
    prepare: DatabaseLike['prepare'];
    transaction: DatabaseLike['transaction'];
  };
}): DatabaseLike {
  return {
    prepare: (sql) => databaseService.getDb().prepare(sql),
    transaction: (fn) => databaseService.getDb().transaction(fn),
  };
}
