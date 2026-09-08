/**
 * McpOrphanTripwire — the OBSERVE-ONLY verification channel for the
 * cyboflowMcpServer spawner-death fix (see orchestrator/mcpServer/parentWatchdog.ts).
 *
 * WHY THIS EXISTS. The Phase 1 fix (ppid watchdog + stdin-EOF fast path) lives
 * entirely INSIDE the cyboflowMcpServer subprocess. If it silently stops working
 * — a future edit reintroduces a code path that skips `startParentWatchdog`, a
 * platform quirk breaks the ppid syscall, whatever — nothing outside that
 * subprocess can find out: a CLI-spawned server's stderr writes to a pipe whose
 * read end died along with its parent, so the write just fails silently (EPIPE)
 * or blocks forever, never reaching any log this app can read. This class is the
 * ONLY channel that can prove the fix is still real, by independently observing
 * the operating system's process table for the exact leak the fix eliminates.
 *
 * This class has NO kill authority — it is a tripwire, not a reaper. Compare
 * {@link ../../services/codexBrokerReaper.CodexBrokerReaper}, which reaps what it
 * finds; this class exists to prove that a DIFFERENT fix's reaping is no longer
 * necessary, so a killer seam here would defeat its own purpose (killing the
 * orphan would remove the very evidence a boot-time author of a regression needs
 * to see). Accordingly there is no `killPid` in {@link McpOrphanTripwireOptions}
 * and no kill method anywhere on {@link McpOrphanTripwire} — this is enforced by
 * the shape of the class, not by convention.
 *
 * WHY PERIODIC, NOT BOOT-ONLY. Orphans can only exist mid-uptime — they are
 * created when a `claude` process holding an MCP server subprocess dies while
 * the app stays up (crash, kill, force-quit of a session but not the app), and
 * they are cleared either by the Phase 1 fix or by the app's own exit. A scan
 * that only ran at boot would therefore read ~zero orphans FOREVER, regardless
 * of whether the fix works — a null signal dressed up as a green one. Hence: one
 * scan immediately at boot (to catch anything already stranded, e.g. from a
 * build that predates the fix) plus a recurring scan every
 * {@link MCP_ORPHAN_SCAN_INTERVAL_MS} (1 hour) to catch orphans created later in
 * the same uptime.
 *
 * WHY CONFIRMATION ACROSS SCANS, NOT AN AGE GATE. The parentWatchdog polls every
 * `PARENT_WATCHDOG_INTERVAL_MS` (60s), so a scan run at an unlucky moment can
 * legitimately observe an orphan the watchdog is mid-flight to killing. Counting
 * that would be a false alarm on a fix working exactly as designed — and a false
 * alarm here is worse than a missed one, because it discredits the only signal
 * this fix has.
 *
 * The obvious guard — "ignore anything younger than 2x the watchdog interval" —
 * is WRONG, and was the first implementation here. `ps` `etime` is the process's
 * TOTAL LIFETIME, not how long it has been orphaned. A server that ran healthily
 * for three hours and lost its spawner one second before a scan has an `etime` of
 * three hours, sails past any age gate, and is counted instantly — precisely the
 * false alarm the gate was added to prevent. The gate measured the wrong quantity
 * and therefore excluded nothing.
 *
 * What actually distinguishes the two cases is DURATION SPENT ORPHANED, which no
 * single `ps` row carries. So a process must be observed with `ppid === 1` on two
 * separate scans at least {@link MCP_ORPHAN_GRACE_MS} apart before it counts. A
 * watchdog-doomed orphan dies within ~60s and never survives to the second
 * sighting; a genuine leak persists forever and always does. `etime` is still
 * read, but only to derive a start time that identifies the process across scans
 * (see the PID-reuse guard in {@link McpOrphanTripwire.scan}).
 *
 * Because a first sighting can never count, a confirmation rescan is scheduled
 * shortly after one appears — otherwise a boot-stranded orphan would go
 * unreported until the next hourly tick.
 */
import { execFile } from 'node:child_process';
import { execWindowsProcessTable } from './winProcessTable';
import { resolveMcpServerScriptPath } from '../orchestrator/mcpServer/scriptPath';
import { PARENT_WATCHDOG_INTERVAL_MS } from '../orchestrator/mcpServer/parentWatchdog';
import type { LoggerLike } from '../orchestrator/types';

/** A single process row parsed from `ps -axo pid=,ppid=,etime=,command=`. */
export interface McpOrphanProcess {
  pid: number;
  ppid: number;
  /** Parsed process age in seconds, or null when `etime` was unparseable. */
  etimeSeconds: number | null;
  command: string;
}

/** How often the recurring scan runs, once boot's immediate scan has fired. */
export const MCP_ORPHAN_SCAN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long a process must remain continuously observed as orphaned before it
 * counts. Derived from {@link PARENT_WATCHDOG_INTERVAL_MS} (2x, imported — never
 * a hardcoded literal) so the two cannot silently drift apart.
 */
export const MCP_ORPHAN_GRACE_MS = PARENT_WATCHDOG_INTERVAL_MS * 2;

/**
 * Delay before the follow-up scan that can confirm a freshly-sighted orphan.
 * Slightly past the grace window so the second sighting is guaranteed to be far
 * enough from the first to count.
 */
export const MCP_ORPHAN_CONFIRM_DELAY_MS = MCP_ORPHAN_GRACE_MS + 30_000;

/**
 * Tolerance, in seconds, when matching a remembered process to a `ps` row by
 * derived start time. `etime` has 1s granularity and the scan's own clock reads
 * are not simultaneous, so a couple of seconds of jitter is expected; anything
 * beyond it means this PID now belongs to a DIFFERENT process.
 */
export const MCP_ORPHAN_START_TIME_TOLERANCE_SEC = 5;

/** Construction-time seams — the real `ps`/script-path-resolver are the defaults. */
export interface McpOrphanTripwireOptions {
  /**
   * Structured logger. REQUIRED, deliberately: every output of this class is a
   * log line, so an instance without one is a verification channel that verifies
   * nothing — which is exactly the bug this class exists to detect in something
   * else. Making it non-optional means that instance cannot be constructed.
   */
  logger: LoggerLike;
  /** List host processes. Defaults to `ps -axo pid=,ppid=,etime=,command=`. */
  listProcesses?: () => Promise<McpOrphanProcess[]>;
  /**
   * Resolve this install's cyboflowMcpServer.js script path. Defaults to
   * {@link resolveMcpServerScriptPath} — injectable so tests need no electron
   * mock.
   */
  resolveScriptPath?: () => string;
  /** Current wall-clock ms. Injectable so tests need no fake timers. */
  now?: () => number;
}

/** What the tripwire remembers about a process between scans. */
interface OrphanSighting {
  /** Epoch seconds at which the process started, derived from `etime`. */
  startedAtSec: number;
  /** Wall-clock ms of the FIRST scan that saw this process orphaned. */
  firstSeenMs: number;
}

/**
 * Parse one `ps` `etime=` field into seconds. macOS emits exactly three shapes:
 * `mm:ss`, `hh:mm:ss`, and `dd-hh:mm:ss` (the `dd-` prefix appears only once
 * elapsed time crosses 24h). Returns null for anything that does not match one
 * of those shapes — an unparseable age is never guessed at, it is simply not
 * counted (see {@link McpOrphanTripwire.scan}).
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

/**
 * Parse `ps -axo pid=,ppid=,etime=,command=` output into rows.
 *
 * Deliberately NOT sharing {@link ../../services/codexBrokerReaper.parsePsOutput}
 * — that parser is 3-column (`pid=,ppid=,command=`) and is shared with
 * PrototypeServerReaper; widening it to 4 columns here would change what both of
 * those callers receive for no benefit to them. A dedicated 4-column parser is
 * one field wider and otherwise identical.
 *
 * Each line is leading whitespace + pid + ppid + the `etime` token (a single
 * `\S+` run — `etime` never contains a space) + the remainder as `command`.
 * Lines that do not match this shape are skipped. This also defends against the
 * macOS `ps: <keyword>: keyword not found` gotcha (an unknown -o keyword still
 * exits 0 and silently omits its column, which would otherwise shift `command`'s
 * first word into the `etime` capture): a shifted capture almost never matches
 * {@link parseEtime}'s shape, so it becomes `etimeSeconds: null` and the row is
 * excluded rather than mis-counted.
 */
export function parseMcpOrphanPsOutput(stdout: string): McpOrphanProcess[] {
  const rows: McpOrphanProcess[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/^\s+/, '');
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      ppid,
      etimeSeconds: parseEtime(match[3]),
      command: match[4],
    });
  }
  return rows;
}

/** Default process lister: `ps -axo pid=,ppid=,etime=,command=` (see macOS gotcha above — NOT `etimes`). */
function defaultListProcesses(): Promise<McpOrphanProcess[]> {
  if (process.platform === 'win32') {
    // Windows has no `ps`; the PowerShell stand-in emits pid/ppid/etime/
    // command lines in the same shape (etime in the macOS mm:ss / hh:mm:ss /
    // dd-hh:mm:ss forms), so the parser below is used unchanged.
    return execWindowsProcessTable('pid-ppid-etime-command').then(parseMcpOrphanPsOutput);
  }
  return new Promise<McpOrphanProcess[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,etime=,command='],
      // Command lines can be long; 16 MiB is comfortably above any realistic
      // full process table (mirrors CodexBrokerReaper's default lister).
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(parseMcpOrphanPsOutput(stdout));
      },
    );
  });
}

/**
 * Timer handle carrying Node's `unref`. See {@link McpOrphanTripwire.start} —
 * the recurring scan must never be the reason the process fails to exit.
 *
 * Intentionally a twin of the same interface in
 * orchestrator/mcpServer/parentWatchdog.ts rather than a shared import; that
 * file is bundled standalone for the MCP subprocess, so sharing would couple the
 * bundle to this tree. See the rationale there before merging them.
 */
interface UnreffableTimer {
  unref?: () => void;
}

export class McpOrphanTripwire {
  private readonly listProcesses: () => Promise<McpOrphanProcess[]>;
  private readonly resolveScriptPath: () => string;
  private readonly logger: LoggerLike;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Processes seen orphaned on a previous scan, keyed by pid. A pid alone is not
   * an identity (the OS reuses them), so each entry also carries the derived
   * start time and is discarded when that stops matching.
   */
  private readonly sightings = new Map<number, OrphanSighting>();

  constructor(opts: McpOrphanTripwireOptions) {
    this.listProcesses = opts.listProcesses ?? defaultListProcesses;
    this.resolveScriptPath = opts.resolveScriptPath ?? resolveMcpServerScriptPath;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Fire one scan immediately, then a recurring scan every
   * {@link MCP_ORPHAN_SCAN_INTERVAL_MS}. The interval is `unref`'d — this
   * tripwire must never be the reason the app's event loop stays alive.
   * Idempotent: a second call while already running is a no-op.
   */
  start(): void {
    if (this.timer !== null) return;
    void this.scan();
    const timer = setInterval(() => {
      void this.scan();
    }, MCP_ORPHAN_SCAN_INTERVAL_MS);
    (timer as unknown as UnreffableTimer).unref?.();
    this.timer = timer;
  }

  /** Cancel the recurring scan and any pending confirmation rescan. Idempotent. */
  stop(): void {
    if (this.confirmTimer !== null) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run one scan pass and log the result. Public (not just interval-private) so
   * boot and tests can trigger a deterministic pass without waiting on the
   * interval. Returns the count found, purely for test convenience — callers
   * that only care about the log (boot) can ignore it.
   *
   * A row is a CANDIDATE when its command contains this install's resolved MCP
   * script path and its ppid is 1 (reparented — the spawner is gone). A
   * candidate only COUNTS once it has been continuously observed that way for
   * {@link MCP_ORPHAN_GRACE_MS}, which is what separates a genuine leak from an
   * orphan the watchdog is about to reap. Fail-soft throughout: a `ps` failure
   * or a script-path resolution failure is logged and this returns 0, never
   * throws.
   */
  async scan(): Promise<number> {
    let processes: McpOrphanProcess[];
    try {
      processes = await this.listProcesses();
    } catch (err) {
      this.logger.error('[McpOrphanTripwire] listing processes failed — skipping scan', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    let scriptPath: string;
    try {
      scriptPath = this.resolveScriptPath();
    } catch (err) {
      this.logger.error('[McpOrphanTripwire] resolving MCP script path failed — skipping scan', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    const stillPresent = new Set<number>();
    let count = 0;
    let pendingConfirmation = 0;

    for (const proc of processes) {
      if (!proc.command.includes(scriptPath)) continue;
      if (proc.ppid !== 1) continue;
      // Without a parsable age there is no way to tell this process apart from a
      // future one that reuses its pid, so it can never be safely confirmed.
      if (proc.etimeSeconds === null) continue;

      stillPresent.add(proc.pid);
      const startedAtSec = nowSec - proc.etimeSeconds;
      const prior = this.sightings.get(proc.pid);

      // PID REUSE GUARD. A remembered pid whose derived start time no longer
      // matches is a different process that inherited the number; its predecessor's
      // first-seen timestamp must not be credited to it, or a brand-new orphan
      // could be "confirmed" instantly.
      const isSameProcess =
        prior !== undefined &&
        Math.abs(prior.startedAtSec - startedAtSec) <= MCP_ORPHAN_START_TIME_TOLERANCE_SEC;

      if (!isSameProcess) {
        this.sightings.set(proc.pid, { startedAtSec, firstSeenMs: nowMs });
        pendingConfirmation += 1;
        continue;
      }

      if (nowMs - prior.firstSeenMs >= MCP_ORPHAN_GRACE_MS) count += 1;
      else pendingConfirmation += 1;
    }

    // Forget processes that are gone (the healthy case: the watchdog reaped them)
    // so the map cannot grow without bound across a long uptime.
    for (const pid of [...this.sightings.keys()]) {
      if (!stillPresent.has(pid)) this.sightings.delete(pid);
    }

    if (count > 0) {
      this.logger.warn(
        '[McpOrphanTripwire] found orphaned cyboflowMcpServer process(es) — the spawner-death ' +
          'fix (parentWatchdog) appears to not be working',
        { count, graceMs: MCP_ORPHAN_GRACE_MS },
      );
    } else {
      this.logger.debug('[McpOrphanTripwire] no confirmed orphaned cyboflowMcpServer processes', {
        pendingConfirmation,
      });
    }

    // A candidate seen for the first time cannot be judged yet, and the next
    // hourly tick is an hour away — schedule a nearer look so a boot-stranded
    // orphan is reported in minutes rather than at the top of the next hour.
    if (pendingConfirmation > 0) this.scheduleConfirmationScan();

    return count;
  }

  /**
   * Arm a one-shot rescan just past the grace window. Only ever one is pending;
   * a second call while one is armed is a no-op, so a long list of candidates
   * cannot pile up timers. `unref`'d for the same reason the interval is.
   */
  private scheduleConfirmationScan(): void {
    if (this.confirmTimer !== null) return;
    const timer = setTimeout(() => {
      this.confirmTimer = null;
      void this.scan();
    }, MCP_ORPHAN_CONFIRM_DELAY_MS);
    (timer as unknown as UnreffableTimer).unref?.();
    this.confirmTimer = timer;
  }
}
