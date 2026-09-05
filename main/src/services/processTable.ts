/**
 * Shared host-process-table parsing and walking helpers — one parser and one
 * walker for the reapers (codexBrokerReaper, vitestOrphanReaper) and the kill
 * ladders (terminalSessionManager, sessionManager, runCommandManager,
 * logsManager) rather than one per caller. Matching is plain JS over parsed
 * rows rather than `pkill -f <regex>`: the paths involved carry regex
 * metacharacters, and a mis-escaped kill pattern is not a risk worth taking.
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
