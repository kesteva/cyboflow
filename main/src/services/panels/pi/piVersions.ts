/**
 * Version discipline for the Pi CLI (@earendil-works/pi-coding-agent).
 *
 * Same policy shape as ompVersions.ts: pi releases continuously and we spawn
 * the USER's binary, so a hard equality pin would rot immediately.
 *
 *   - PI_MIN_SUPPORTED_VERSION — hard floor; below it probes report
 *     'unavailable' because behavior this integration depends on may be
 *     absent: `--mode json` (session-header v3 event stream),
 *     `--session-id <id>` create-or-resume-by-exact-id (verified live: turn 2
 *     answered from turn-1 context under the pinned id), and the extension
 *     `tool_call` blocking hook.
 *   - PI_TESTED_VERSION — newest verified version; newer binaries are accepted
 */

/** Hard floor: a probed pi binary below this version is refused. */
export const PI_MIN_SUPPORTED_VERSION = '0.84.0';

/** Newest version verified against; soft ceiling only — never refuses. */
export const PI_TESTED_VERSION = '0.84.2';

export interface PiVersionVerdict {
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
export function evaluatePiVersionPolicy(rawVersion: string): PiVersionVerdict {
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
  const belowFloor = cmp(parsed, toTuple(PI_MIN_SUPPORTED_VERSION)) < 0;
  return {
    ok: !belowFloor,
    aboveTested: cmp(parsed, toTuple(PI_TESTED_VERSION)) > 0,
    reason: belowFloor ? 'below-floor' : undefined,
  };
}
