/**
 * PrototypeServerReaper (TASK-057) — the main-process lifecycle owner for the
 * DETACHED `python3 -m http.server` processes the Planner/Ship `ui-prototype`
 * subagent starts to serve its static prototype during the human-review window.
 *
 * The subagent launches that server with `nohup ... &`, so it deliberately
 * OUTLIVES its own subagent turn (the prototype tab must keep rendering while the
 * run rests awaiting review). Nothing in the main process used to reap it, so
 * stale servers accumulated on the host across runs and app restarts. This
 * service kills them at the terminal seams the main process owns: run close-out
 * (merge / createPr / dismiss / cancel), boot (orphans from a prior session), and
 * app quit.
 *
 * This is NOT the visual-verification static server (StaticServerManager) — that
 * one is an IN-PROCESS tokenized node server owned by the main process and torn
 * down by its own release(); it never spawns a `python3 -m http.server` child and
 * is left untouched here.
 *
 * Matching strategy (deliberate): we do NOT `pkill -f <regex>` with the raw
 * artifacts path — an absolute path can contain regex metacharacters and would
 * mis-escape. Instead we list processes via `ps -axo pid=,command=` and do plain
 * JS substring matching on the command line, requiring the literal `http.server`
 * marker AND the literal target directory substring. Deterministic, no escaping
 * bugs. Every path is fail-soft: a `ps` failure or a per-PID kill failure is
 * logged and swallowed, never thrown — reaping must never block close-out/quit.
 */
import { execFile } from 'node:child_process';
import type { LoggerLike } from '../orchestrator/types';

/** A single process row parsed from `ps` output. */
export interface ProcessInfo {
  pid: number;
  command: string;
}

/** Construction-time seams — the real `ps`/`process.kill` impls are the defaults. */
export interface PrototypeServerReaperOptions {
  /** List host processes. Defaults to `ps -axo pid=,command=`. */
  listProcesses?: () => Promise<ProcessInfo[]>;
  /** Kill one PID (SIGTERM). Defaults to `process.kill(pid, 'SIGTERM')`. */
  killPid?: (pid: number) => void;
  /** Optional structured logger (warn on kills, debug on misses/skips). */
  logger?: LoggerLike;
}

/** The literal marker every prototype server's command line carries. */
const HTTP_SERVER_MARKER = 'http.server';
/** The prototype subdirectory the server is always pointed at. */
const PROTOTYPE_SEGMENT = '/prototype';

/**
 * Strip trailing path separators from a directory string. Returns '' for an
 * empty/whitespace-only/undefined input — the caller treats '' as "bail, do not
 * match" (an empty target substring would match EVERY http.server process).
 */
function trimDir(dir: string | undefined): string {
  if (!dir) return '';
  const trimmed = dir.trim();
  if (trimmed.length === 0) return '';
  return trimmed.replace(/\/+$/, '');
}

/**
 * Parse `ps -axo pid=,command=` output into rows. Each line is leading
 * whitespace + numeric pid + a single space + the full command line. Lines that
 * do not match (blank / header-less garbage) are skipped.
 */
function parsePsOutput(stdout: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/^\s+/, '');
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, command: match[2] });
  }
  return rows;
}

/** Default process lister: `ps -axo pid=,command=` (no header, all processes). */
function defaultListProcesses(): Promise<ProcessInfo[]> {
  return new Promise<ProcessInfo[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,command='],
      // Command lines can be long; 16 MiB is comfortably above any realistic
      // full process table.
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(parsePsOutput(stdout));
      },
    );
  });
}

/** Default killer: SIGTERM the PID. May throw (dead/reparented PID) — caller guards. */
function defaultKillPid(pid: number): void {
  process.kill(pid, 'SIGTERM');
}

export class PrototypeServerReaper {
  private readonly listProcesses: () => Promise<ProcessInfo[]>;
  private readonly killPid: (pid: number) => void;
  private readonly logger?: LoggerLike;

  constructor(opts: PrototypeServerReaperOptions = {}) {
    this.listProcesses = opts.listProcesses ?? defaultListProcesses;
    this.killPid = opts.killPid ?? defaultKillPid;
    this.logger = opts.logger;
  }

  /**
   * Kill every process whose command line contains BOTH `http.server` AND the
   * given run's `<runArtifactsDir>/prototype` directory. Called at run close-out
   * (merge / createPr / dismiss / cancel). Fail-soft and a no-op for an
   * empty/undefined `runArtifactsDir` (matching on '' would kill ALL servers).
   */
  async reapForRun(runArtifactsDir: string): Promise<void> {
    const base = trimDir(runArtifactsDir);
    if (base.length === 0) {
      this.logger?.debug('[PrototypeServerReaper] empty runArtifactsDir — skipping reap');
      return;
    }
    const prototypeDir = base + PROTOTYPE_SEGMENT;
    await this.killMatching(
      (command) => command.includes(HTTP_SERVER_MARKER) && command.includes(prototypeDir),
      'reapForRun',
      prototypeDir,
    );
  }

  /**
   * Kill every process whose command line contains `http.server` AND a path
   * under `<artifactsRunsRoot>/` ending in `/prototype`. Used at boot (orphans
   * from a prior session) and before app quit. Fail-soft and a no-op for an
   * empty/undefined `artifactsRunsRoot`.
   *
   * `isRunLive` (optional) makes the boot call a LIVE-RUN-AWARE backstop: after an
   * unclean shutdown a run left `awaiting_review` still has its detached server
   * running, and killing it would leave the user's prototype tab dead when they
   * reopen to review. When provided, the parsed `<runId>` of a matched server is
   * checked against `isRunLive` and a LIVE run's server is SPARED. Omitting the
   * predicate (the before-quit call) keeps the kill-all behavior — nothing renders
   * once the app is quitting. An unparseable path falls through to killing (an
   * orphan path with no extractable runId is still an orphan).
   */
  async sweepOrphans(
    artifactsRunsRoot: string,
    isRunLive?: (runId: string) => boolean,
  ): Promise<void> {
    const root = trimDir(artifactsRunsRoot);
    if (root.length === 0) {
      this.logger?.debug('[PrototypeServerReaper] empty artifactsRunsRoot — skipping sweep');
      return;
    }
    const rootPrefix = root + '/';
    await this.killMatching(
      (command) => {
        if (!command.includes(HTTP_SERVER_MARKER)) return false;
        const idx = command.indexOf(rootPrefix);
        if (idx < 0) return false;
        // A `/prototype` segment must appear AT/AFTER the runs-root prefix — i.e.
        // the served dir is `<root>/<runId>/prototype`, not merely any command
        // that happens to mention both the root and the word prototype elsewhere.
        const afterRoot = command.slice(idx + rootPrefix.length);
        const protoIdx = afterRoot.indexOf(PROTOTYPE_SEGMENT);
        if (protoIdx < 0) return false;
        // Live-run-aware backstop: spare a server whose run is still non-terminal
        // (a crash left it serving a run the user hasn't reviewed yet). The runId
        // is the segment between `<root>/` and `/prototype`. Parse defensively — an
        // empty/unparseable runId falls through to killing (still an orphan).
        if (isRunLive) {
          const runId = afterRoot.slice(0, protoIdx);
          if (runId.length > 0 && !runId.includes('/') && isRunLive(runId)) {
            this.logger?.debug('[PrototypeServerReaper] sparing live run prototype server', {
              runId,
            });
            return false;
          }
        }
        return true;
      },
      'sweepOrphans',
      rootPrefix,
    );
  }

  /**
   * Shared core: list processes, kill every match fail-soft (a dead/reparented
   * PID or a throwing kill for one process never aborts the loop), and log the
   * outcome. A `ps` failure logs and returns — never throws out of the reaper.
   */
  private async killMatching(
    matches: (command: string) => boolean,
    context: string,
    target: string,
  ): Promise<void> {
    let processes: ProcessInfo[];
    try {
      processes = await this.listProcesses();
    } catch (err) {
      this.logger?.error('[PrototypeServerReaper] listing processes failed — skipping', {
        context,
        target,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let killed = 0;
    for (const proc of processes) {
      if (!matches(proc.command)) continue;
      try {
        this.killPid(proc.pid);
        killed += 1;
        this.logger?.warn('[PrototypeServerReaper] killed leaked prototype server', {
          context,
          pid: proc.pid,
          target,
        });
      } catch (err) {
        // A dead / reparented / permission-denied PID must not abort the loop.
        this.logger?.debug('[PrototypeServerReaper] kill failed (already gone?) — continuing', {
          context,
          pid: proc.pid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (killed === 0) {
      this.logger?.debug('[PrototypeServerReaper] no matching prototype servers', {
        context,
        target,
      });
    }
  }
}
