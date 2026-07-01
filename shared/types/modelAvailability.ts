/**
 * modelAvailability — the small set of Claude models cyboflow guards for
 * availability, plus the wire shapes shared frontend↔main over IPC.
 *
 * Fable 5 is Anthropic's frontier model and has been pulled from availability
 * before, so a run or agent pinned to it must degrade gracefully rather than
 * hard-fail. The backend {@link !ModelAvailabilityService} tracks each guarded
 * model's status; the spawn seam swaps an unavailable guarded model to its
 * `fallbackAlias` (see `applyModelAvailabilityFallback` in modelContext), and the
 * pickers grey out its option. A model that is NOT in {@link GUARDED_MODELS} is
 * always treated as usable — the historical behavior, where an unknown id passes
 * straight through to the SDK untouched.
 */

/** One model cyboflow guards for availability, with its fallback family. */
export interface GuardedModelSpec {
  /** Picker alias the user selects (e.g. 'fable'). Lower-case. */
  readonly alias: string;
  /**
   * The concrete snapshot id `resolveModelAlias(alias)` produces, BARE of any
   * `[1m]` window marker — the form the runtime spawns and the Models API knows.
   */
  readonly concreteId: string;
  /** Human label for logs / tooltips (e.g. 'Fable 5'). */
  readonly label: string;
  /** Picker alias to fall back to when unavailable (resolved at the spawn seam). */
  readonly fallbackAlias: string;
}

/**
 * The guarded models. Currently only Fable 5, which falls back to Opus.
 *
 * Keep `concreteId` in sync with the {@link resolveModelAlias} mapping for the
 * same `alias` (bare, no `[1m]`). Adding a model here is all that's needed to
 * guard it: the service seeds it, the spawn seam swaps it, and the pickers grey
 * it out.
 */
export const GUARDED_MODELS: readonly GuardedModelSpec[] = [
  { alias: 'fable', concreteId: 'claude-fable-5', label: 'Fable 5', fallbackAlias: 'opus' },
];

export type ModelAvailabilityStatus = 'available' | 'unavailable' | 'unknown';

/** The tracked state of one guarded model. */
export interface ModelAvailabilityEntry {
  readonly concreteId: string;
  readonly status: ModelAvailabilityStatus;
  /** Short human reason when unavailable (e.g. '404'), else null. */
  readonly reason: string | null;
  /** Epoch-ms of the last status write, or null if never checked. */
  readonly checkedAt: number | null;
}

/** concreteId → entry. Only guarded models appear; the IPC snapshot shape. */
export type ModelAvailabilityMap = Record<string, ModelAvailabilityEntry>;

/**
 * Renderer push emitted when a run's turn DISCOVERED its pinned guarded model was
 * unavailable mid-call and transparently retried on the fallback family. The
 * picker/composer uses it to swap the visible model pill and show a one-off toast
 * (distinct from {@link ModelAvailabilityMap}, which drives the persistent
 * grey-out). Scoped to a single panel/session so only that composer reacts.
 */
export interface ModelFallbackNotice {
  /** The run/panel that fell back (a quick session's claude panel id). */
  readonly panelId: string;
  /** The cyboflow session id owning the panel. */
  readonly sessionId: string;
  /** The guarded picker alias that was unavailable (e.g. 'fable'). */
  readonly unavailableAlias: string;
  /** Human label of the unavailable model (e.g. 'Fable 5'). */
  readonly unavailableLabel: string;
  /** The picker alias the turn ran on instead (e.g. 'opus'). */
  readonly fallbackAlias: string;
}

/** Strip a `[1m]` window marker and normalize for comparison. */
function normalizeId(id: string): string {
  return id.toLowerCase().replace(/\[1m\]\s*$/i, '').trim();
}

/** The guarded spec whose `alias` matches (case/space-insensitive), or undefined. */
export function guardedModelByAlias(alias: string | null | undefined): GuardedModelSpec | undefined {
  if (!alias) return undefined;
  const key = alias.toLowerCase().trim();
  return GUARDED_MODELS.find((g) => g.alias === key);
}

/**
 * The guarded spec matching a RESOLVED concrete id (any `[1m]` marker stripped,
 * case-insensitive), or undefined. Used at the spawn seam and error path where the
 * id has already been through `resolveModelAlias`.
 */
export function guardedModelByConcreteId(id: string | null | undefined): GuardedModelSpec | undefined {
  if (!id) return undefined;
  const bare = normalizeId(id);
  return GUARDED_MODELS.find((g) => g.concreteId.toLowerCase() === bare);
}

/**
 * Whether a picker alias is usable given an availability snapshot. Non-guarded
 * aliases (opus/sonnet/haiku/auto/…) are always usable; a guarded alias is usable
 * unless its entry is explicitly `'unavailable'` ('unknown' is optimistically
 * usable). Pure — the frontend picker calls this against the store snapshot.
 */
export function isAliasUsable(alias: string | null | undefined, map: ModelAvailabilityMap): boolean {
  const guarded = guardedModelByAlias(alias);
  if (!guarded) return true;
  return map[guarded.concreteId]?.status !== 'unavailable';
}
