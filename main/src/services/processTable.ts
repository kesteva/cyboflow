/**
 * Shared host-process-table parsing and walking helpers — one parser and one
 * walker for the reapers (codexBrokerReaper, vitestOrphanReaper) and the kill
 * ladders in utils/platformProcess.ts rather than one per caller. Matching is
 * plain JS over parsed rows rather than `pkill -f <regex>`: the paths involved
 * carry regex metacharacters, and a mis-escaped kill pattern is not a risk
 * worth taking.
 *
 * Deliberately platform-BLIND: only text shapes are parsed and walked here.
 * The platform choice (which subprocess produces the lines, how trees die)
 * lives in utils/platformProcess.ts.
 */

/** A single process row parsed from `ps` output. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** One row of the two-column (pid, ppid) process table — all a kill ladder needs. */
export interface ProcessTableRow {
  pid: number;
  ppid: number;
}

/**
 * Parse `ps -axo pid=,ppid=` output ("<pid> <ppid>" per line, no header) into
 * rows. Lines that don't match a plain numeric pair are skipped — `ps` output is
 * not a contract, and one odd line must never take down a sweep.
 */
export function parseProcessTable(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ppid });
  }
  return rows;
}

/**
 * Collect every descendant of `rootPid` by walking the ppid table (BFS,
 * cycle-safe). Excludes the root itself, never traverses pid<=1 (never chase
 * launchd/kernel via a stray reparent), and returns [] for a root of pid<=1.
 * Mirrors the tree-walk in {@link collectProcessTree}.
 */
export function collectDescendantPids(rootPid: number, procs: ProcessTableRow[]): number[] {
  const childrenByPpid = new Map<number, number[]>();
  for (const p of procs) {
    if (p.pid <= 1) continue;
    const list = childrenByPpid.get(p.ppid);
    if (list) list.push(p.pid);
    else childrenByPpid.set(p.ppid, [p.pid]);
  }

  // Never traverse from a root of launchd/kernel itself (mirrors codexBrokerReaper's
  // collectProcessTree guard) — a reparented pid<=1 root has no legitimate descendants
  // to enumerate here.
  if (rootPid <= 1) return [];

  const result = new Set<number>();
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const kids = childrenByPpid.get(current);
    if (!kids) continue;
    for (const kid of kids) {
      if (kid > 1 && kid !== rootPid && !result.has(kid)) {
        result.add(kid);
        queue.push(kid);
      }
    }
  }
  return [...result];
}

/**
 * Parse `ps -axo pid=,ppid=,command=` output into rows. Each line is leading
 * whitespace + numeric pid + whitespace + numeric ppid + a space + the full
 * command line. Lines that do not match are skipped — `ps` output is not a
 * contract, and one odd line must never take down a sweep.
 */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/^\s+/, '');
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ppid, command: match[3] });
  }
  return rows;
}

/**
 * Collect `rootPids` plus every descendant, walking the ppid table. Guards:
 * pids ≤ 1 are never traversed or included (never chase launchd/kernel), a pid is
 * only ever visited once (cycle-safe), and a root not present in `procs` is still
 * returned (a parent whose children already exited). Returns a de-duplicated set.
 */
export function collectProcessTree(rootPids: number[], procs: ProcessRow[]): Set<number> {
  const childrenByPpid = new Map<number, number[]>();
  for (const p of procs) {
    if (p.pid <= 1) continue;
    const list = childrenByPpid.get(p.ppid);
    if (list) list.push(p.pid);
    else childrenByPpid.set(p.ppid, [p.pid]);
  }

  const result = new Set<number>();
  const queue: number[] = [];
  for (const root of rootPids) {
    if (root > 1 && !result.has(root)) {
      result.add(root);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const kids = childrenByPpid.get(pid);
    if (!kids) continue;
    for (const kid of kids) {
      if (kid > 1 && !result.has(kid)) {
        result.add(kid);
        queue.push(kid);
      }
    }
  }
  return result;
}

/**
 * Parse one `ps` `etime=` field into seconds. macOS emits exactly three shapes:
 * `mm:ss`, `hh:mm:ss`, and `dd-hh:mm:ss` (the `dd-` prefix appears only once
 * elapsed time crosses 24h). Returns null for anything that does not match one
 * of those shapes — an unparseable age is never guessed at.
 */
export function parseEtime(raw: string): number | null {
  const s = raw.trim();
  const dayMatch = /^(\d+)-(.+)$/.exec(s);
  const days = dayMatch ? Number.parseInt(dayMatch[1], 10) : 0;
  const rest = dayMatch ? dayMatch[2] : s;

  const parts = rest.split(':');
  // dd- form must carry hh:mm:ss (3 fields); the bare form is mm:ss or hh:mm:ss.
  if (dayMatch && parts.length !== 3) return null;
  if (!dayMatch && parts.length !== 2 && parts.length !== 3) return null;
  if (parts.some((p) => !/^\d{1,2}$/.test(p))) return null;

  const nums = parts.map((p) => Number.parseInt(p, 10));
  const [hours, minutes, seconds] =
    nums.length === 3 ? nums : [0, nums[0], nums[1]];
  // Defensive: a genuine ps etime field never carries an out-of-range mm/ss.
  if (minutes >= 60 || seconds >= 60) return null;

  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/** One row of the six-column process snapshot (`pid,ppid,pcpu,pmem,etime,command`). */
export interface ProcessSnapshotRow {
  pid: number;
  ppid: number;
  /** CPU percent; null when `ps` printed `-` or a non-numeric value. Never 0/NaN as a stand-in. */
  pcpu: number | null;
  /** Memory percent; null when `ps` printed `-` or a non-numeric value. */
  pmem: number | null;
  /** Elapsed seconds; null when the etime token is present but unparseable. */
  etimeSeconds: number | null;
  command: string;
}

/**
 * A `ps` percentage column. `ok: false` means the token is shaped like a
 * shifted-in etime (contains `:`), i.e. the row's columns are misaligned and
 * the whole row must be skipped. Any other unparseable token (`-`, `abc`,
 * `1,5`) is a malformed value in the right slot: the row is kept and the field
 * is `null`.
 */
function parsePercentToken(token: string): { ok: boolean; value: number | null } {
  if (/^\d+(?:\.\d+)?$/.test(token)) {
    const value = Number.parseFloat(token);
    return { ok: true, value: Number.isFinite(value) ? value : null };
  }
  if (token.includes(':')) return { ok: false, value: null };
  return { ok: true, value: null };
}

/**
 * Parse `ps -axo pid=,ppid=,pcpu=,pmem=,etime=,command=` output into rows.
 *
 * Defensive like the other parsers: unparseable lines are skipped, and an
 * unparseable numeric field becomes `null` (never 0/NaN). It also defends
 * against the macOS `ps: <keyword>: keyword not found` gotcha (an unknown -o
 * keyword still exits 0 and silently drops its column, shifting every later
 * field left): a shifted line puts a non-numeric token in the pcpu/pmem slot or
 * a command word in the etime slot (a `:`-shaped token in a percent slot), and such a row is SKIPPED rather than
 * mis-parsed. An etime token that merely looks like a time (digits, `:`, `-`
 * only) but fails {@link parseEtime} keeps the row with `etimeSeconds: null`.
 */
export function parsePsOutputWithCpuMem(stdout: string): ProcessSnapshotRow[] {
  const rows: ProcessSnapshotRow[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/^\s+/, '');
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const pcpu = parsePercentToken(match[3]);
    const pmem = parsePercentToken(match[4]);
    if (!pcpu.ok || !pmem.ok) continue;
    if (!/^[\d:.-]+$/.test(match[5])) continue;
    rows.push({
      pid,
      ppid,
      pcpu: pcpu.value,
      pmem: pmem.value,
      etimeSeconds: parseEtime(match[5]),
      command: match[6],
    });
  }
  return rows;
}
