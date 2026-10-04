/**
 * Persisted group-by preference for the System view ("By worktree" /
 * "By process type"). The legacy key is the pre-rename "Monitor" name, so a
 * value saved under it survives the rename; all reads go through
 * migrateLocalStorageKey per the repo's key-rename rule.
 */
import { migrateLocalStorageKey } from './migrateLocalStorageKey';

export type SystemGroupBy = 'worktree' | 'process-type';

export const DEFAULT_SYSTEM_GROUP_BY: SystemGroupBy = 'worktree';

const LEGACY_KEY = 'cyboflow-monitor-group-by';
const KEY = 'cyboflow-system-group-by';

/** Read the persisted grouping; defaults to 'worktree' when unset, invalid, or storage is unavailable. */
export function getSystemGroupByPreference(): SystemGroupBy {
  const raw = migrateLocalStorageKey(LEGACY_KEY, KEY);
  return raw === 'process-type' || raw === 'worktree' ? raw : DEFAULT_SYSTEM_GROUP_BY;
}

/** Persist the grouping. Swallows storage failures (private mode). */
export function setSystemGroupByPreference(value: SystemGroupBy): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Ignore — a failed persist must never break the view.
  }
}
