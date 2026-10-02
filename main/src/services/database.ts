import type { DatabaseService } from '../database/database';

/**
 * Module-level access to THE DatabaseService for code that is not handed one
 * (PanelManager, the panels IPC, session validation). index.ts owns the only
 * instance: it constructs it, runs the schema-version gate, initializes it,
 * and only then registers it here. Nothing opens a second connection, so
 * nothing touches the schema before the gate and every caller shares the same
 * in-memory caches.
 */
let instance: DatabaseService | null = null;

/** Called once by index.ts, after initialize() has succeeded. */
export function setDatabaseService(db: DatabaseService): void {
  instance = db;
}

function requireInstance(): DatabaseService {
  if (!instance) {
    throw new Error('DatabaseService used before index.ts registered it (setDatabaseService)');
  }
  return instance;
}

/**
 * Forwards every property read to the registered instance, so importers keep
 * calling `databaseService.getSession(...)` while the instance itself is
 * created later, by index.ts. Methods are bound to the instance.
 */
export const databaseService: DatabaseService = new Proxy({} as DatabaseService, {
  get(_target, prop) {
    const db = requireInstance();
    const value: unknown = Reflect.get(db, prop, db);
    return typeof value === 'function' ? value.bind(db) : value;
  },
});
