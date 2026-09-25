/**
 * comparisonBase — shared reader for the persisted Diff-tab comparison-base
 * SELECTION (TASK-218 BaseSelector; TASK-278 the quick-session card following
 * it).
 *
 * `RunRightRail.tsx` is the sole WRITER of `COMPARISON_BASE_KEY`
 * (`handleComparisonBaseChange`, fired by `BaseSelector`'s `onChange`) — that
 * write path stays there, next to the component that owns the control. This
 * module exists so every READER (the rail itself, and
 * `useSessionMetrics.ts`'s quick-session-card poll) parses the SAME
 * localStorage value the SAME way, rather than each hand-rolling its own
 * degrade-to-empty-map logic and silently drifting on a key rename or a
 * malformed-value edge case.
 *
 * The persisted value is a JSON-serialized `Record<string, string | null>`
 * map keyed by `selectedSessionId` when present, else the active run id —
 * never a single scalar, since different sessions/runs can each have their
 * own selection. This is the raw SELECTION the user picked (`null` = "Branch
 * point", the default) — never the RESOLVED base a panel's fetch echoes back
 * (see RunRightRail's `resolvedBaseBySession`), which is a different concept
 * entirely and lives only in that component's local state.
 */

/** localStorage key for the persisted comparison-base SELECTION. Brand-new
 * key as of TASK-218 — no migration. */
export const COMPARISON_BASE_KEY = 'cyboflow.runRightRail.comparisonBase';

/** Best-effort read of the persisted comparison-base selection map. Any
 * malformed/absent value degrades to an empty map, never a throw. */
export function loadComparisonBaseMap(): Record<string, string | null> {
  if (typeof localStorage === 'undefined') return {};
  const raw = localStorage.getItem(COMPARISON_BASE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, string | null>) : {};
  } catch {
    return {};
  }
}

/**
 * Read the persisted comparison-base ref for one key (a session id, matching
 * how `RunRightRail` keys `comparisonBaseKey` for a run-less session — see
 * that component's doc comment). Returns `null` for a `null` key (nothing to
 * look up) or when nothing is persisted for it — both mean "Branch point",
 * the default.
 */
export function readComparisonBaseRef(key: string | null): string | null {
  if (key === null) return null;
  return loadComparisonBaseMap()[key] ?? null;
}
