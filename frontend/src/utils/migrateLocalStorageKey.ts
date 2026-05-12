/**
 * Migrates a legacy localStorage key to a new key name (one-shot).
 *
 * - If `newKey` already exists, returns its value immediately (no side-effects).
 * - If only `legacyKey` exists, copies the value to `newKey`, removes `legacyKey`,
 *   and returns the value.
 * - If neither key exists, returns `null`.
 * - If localStorage is inaccessible (e.g. Safari private mode), returns `null`
 *   instead of throwing.
 */
export function migrateLocalStorageKey(legacyKey: string, newKey: string): string | null {
  try {
    const current = localStorage.getItem(newKey);
    if (current !== null) return current;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy === null) return null;
    localStorage.setItem(newKey, legacy);
    localStorage.removeItem(legacyKey);
    return legacy;
  } catch {
    return null;
  }
}
