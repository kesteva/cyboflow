/**
 * Hybrid logical clock strings for cross-machine backlog sync.
 *
 * Format: "<ms13>:<ctr5>:<deviceId>" — wall-clock milliseconds zero-padded to
 * 13 digits, a 5-digit counter, then the device id (which may itself contain
 * ':'). Fixed-width numeric prefixes make plain string comparison agree with
 * (ms, ctr) ordering, and the device id is the deterministic tie-break, so two
 * machines always order the same pair of edits the same way. The clock never
 * goes backwards even if the wall clock does (NTP step, sleep/wake).
 */

export type Hlc = { ms: number; ctr: number; deviceId: string };

const HLC_RE = /^(\d{13}):(\d{5}):(.+)$/;
const MAX_CTR = 99999;

export function parseHlc(s: string): Hlc | null {
  const m = HLC_RE.exec(s);
  if (!m) return null;
  return { ms: Number(m[1]), ctr: Number(m[2]), deviceId: m[3] };
}

export function formatHlc(h: Hlc): string {
  return `${String(h.ms).padStart(13, '0')}:${String(h.ctr).padStart(5, '0')}:${h.deviceId}`;
}

export function compareHlc(a: string, b: string): number {
  const pa = parseHlc(a);
  const pb = parseHlc(b);
  if (pa && pb) {
    if (pa.ms !== pb.ms) return pa.ms < pb.ms ? -1 : 1;
    if (pa.ctr !== pb.ctr) return pa.ctr < pb.ctr ? -1 : 1;
    if (pa.deviceId === pb.deviceId) return 0;
    return pa.deviceId < pb.deviceId ? -1 : 1;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export class HlcClock {
  private readonly now: () => number;
  private state: { ms: number; ctr: number } | null;

  constructor(
    private readonly deviceId: string,
    opts: { now?: () => number; last?: string | null } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    const parsed = opts.last ? parseHlc(opts.last) : null;
    this.state = parsed ? { ms: parsed.ms, ctr: parsed.ctr } : null;
  }

  get last(): string | null {
    return this.state ? formatHlc({ ...this.state, deviceId: this.deviceId }) : null;
  }

  next(): string {
    const wall = this.now();
    let ms = this.state ? Math.max(wall, this.state.ms) : wall;
    let ctr = this.state && ms === this.state.ms ? this.state.ctr + 1 : 0;
    if (ctr > MAX_CTR) {
      ms += 1;
      ctr = 0;
    }
    this.state = { ms, ctr };
    return formatHlc({ ms, ctr, deviceId: this.deviceId });
  }

  /** Merge a remote HLC so the next local one is greater than it. Own device id is kept. */
  observe(remote: string): void {
    const r = parseHlc(remote);
    if (!r) return;
    if (!this.state || r.ms > this.state.ms) {
      this.state = { ms: r.ms, ctr: r.ctr };
    } else if (r.ms === this.state.ms && r.ctr > this.state.ctr) {
      this.state = { ms: r.ms, ctr: r.ctr };
    }
  }
}

/** An HLC at the ISO timestamp's ms with counter 0; null when unparseable. */
export function hlcFromIso(iso: string, deviceId: string): string | null {
  let s = iso.trim();
  // SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS" with no zone: that is UTC.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    s = `${s.replace(' ', 'T')}Z`;
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms) || ms < 0 || ms > 9_999_999_999_999) return null;
  return formatHlc({ ms, ctr: 0, deviceId });
}
