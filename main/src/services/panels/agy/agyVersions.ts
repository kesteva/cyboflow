/**
 * Version discipline for the Antigravity CLI (`agy`).
 *
 * Same policy shape as piVersions.ts / ompVersions.ts:
 *   - AGY_MIN_SUPPORTED_VERSION — hard floor; below it probes report 'unavailable'
 *   - AGY_TESTED_VERSION — newest verified version; newer binaries are accepted with warning
 */

/** Hard floor: a probed agy binary below this version is refused. */
export const AGY_MIN_SUPPORTED_VERSION = '1.0.0';

/** Newest version verified against; soft ceiling only — never refuses. */
export const AGY_TESTED_VERSION = '1.1.25';

export interface AgyVersionVerdict {
  ok: boolean;
  aboveTested: boolean;
  /** Why a binary failed: below the floor, or unparseable `--version` output. */
  reason?: 'below-floor' | 'unparseable';
}

/**
 * Compare a probed semver string against the floor/tested pair. Non-semver
 * output fails closed (`ok: false`) so a broken `--version` never reads as a
 * usable binary.
 */
export function evaluateAgyVersionPolicy(rawVersion: string): AgyVersionVerdict {
  const match = rawVersion.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { ok: false, aboveTested: false, reason: 'unparseable' };
  const toTuple = (v: string): [number, number, number] =>
    v.split('.').map(Number) as [number, number, number];
  const cmp = (a: [number, number, number], b: [number, number, number]): number => {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  };
  const parsed = toTuple(match[0]);
  const belowFloor = cmp(parsed, toTuple(AGY_MIN_SUPPORTED_VERSION)) < 0;
  return {
    ok: !belowFloor,
    aboveTested: cmp(parsed, toTuple(AGY_TESTED_VERSION)) > 0,
    reason: belowFloor ? 'below-floor' : undefined,
  };
}
