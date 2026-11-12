/**
 * remoteFencing — process fencing and `<remoteRoot>/run` cleanup for SSH environments (spec M2 §7, Phase F).
 *
 *  F1 fenceSpawnKey      before a remote COLD spawn re-dispatches spawnKey K: every pidfile of K
 *                        (`<remoteRoot>/run/<K>.<nonce>.pid`, remoteLaunch.pidFileBasenameGlob) whose pid is alive
 *                        AND still in the recorded process group gets `kill -TERM -<pgid>`; survivors after ~3 s get
 *                        KILL; every one of K's pidfiles is removed. A pid that is alive but in ANOTHER group was
 *                        reused by an unrelated process: never signalled, its stale pidfile just removed. Bounded
 *                        (FENCE_TIMEOUT_MS) and never rejects: a failed fence is logged and the spawn proceeds.
 *  F2 reapRunPidFiles    when a run ends: its pidfiles (`<runId>.*`, `<runId>-*`, `<runId>_*` — the session spawnKey
 *                        and lane keys made filename-safe by remoteRuntime.remoteSpawnKey) whose pid is dead.
 *     RemoteProcessTracker every live SshHost spawn, so the quit drain (HostsService.shutdown) can TERM / KILL them
 *                        within a 2 s budget.
 *  F3 gcRemoteRunDir     after a full preflight on a reachable machine: `run/*` files older than 24 h — a pidfile
 *                        only when its pid is dead, a token file only when the caller says its run is not active,
 *                        anything else (temp files of an interrupted write) always.
 *
 * Every remote program is FIXED one-line POSIX sh text (the remote login shell may be csh-family); paths and names
 * are positional parameters. Each one `cd`s into the run dir first and only ever touches plain files there by
 * basename — nothing outside `<remoteRoot>/run` can be named. Output is a few numbers / our own file names; nothing
 * secret is read (pidfiles hold `<pid> <pgid>`, token files are never read).
 */
import type { HostProcess, MachineExec } from '../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../orchestrator/types';
import { pidFileBasenameGlob } from './remoteLaunch';

/** Upper bound a fence may delay a spawn (one ssh round trip + the 3 s TERM window + the KILL pass). */
export const FENCE_TIMEOUT_MS = 4_500;
/** How long survivors of TERM get before KILL, in deciseconds (the program's wait unit). */
export const FENCE_TERM_WAIT_DECISECONDS = 30;
/** Run-teardown and GC programs are one quick pass each. */
export const RUN_DIR_OP_TIMEOUT_MS = 10_000;
/** F3: `run/*` entries older than this are collectable. */
export const RUN_DIR_GC_MAX_AGE_MINUTES = 24 * 60;
/** F2 quit drain: the whole remote kill pass never holds quit longer than this. */
export const QUIT_DRAIN_BUDGET_MS = 2_000;

const RUN_DIR_PRELUDE = 'd=$1; case "$d" in "~/"*) d="$HOME/${d#??}" ;; esac; ';

/**
 * F1. $1 = run dir, $2 = ONE spawnKey's basename glob (no whitespace: spawn keys are `[A-Za-z0-9._-]`), $3 = TERM
 * wait in deciseconds. Prints `<termed> <killed> <stale>`.
 *  o(): the pidfile's pid is > 1, alive, and (when both are known) still in the recorded pgid — sets p g c;
 *  s(): signal the recorded group when verified, else the pid alone.
 * The wait polls every 0.2 s (`sleep 0.2`; a sleep(1) without fractions falls back to 1 s steps — the budget is
 * counted in deciseconds either way) and stops as soon as nothing is alive.
 */
export const FENCE_PROGRAM =
  RUN_DIR_PRELUDE +
  'cd -- "$d" 2>/dev/null || { echo "0 0 0"; exit 0; }; ' +
  'o() { p=; g=; c=; read p g 2>/dev/null < "$1"; ' +
  'case "$p" in ""|*[!0-9]*) return 1 ;; esac; case "$g" in ""|*[!0-9]*) g= ;; esac; ' +
  '[ "$p" -gt 1 ] && kill -0 "$p" 2>/dev/null || return 1; ' +
  'c=$(ps -o pgid= -p "$p" 2>/dev/null | tr -d " "); ' +
  'if [ -n "$g" ] && [ -n "$c" ] && [ "$c" != "$g" ]; then return 1; fi; return 0; }; ' +
  's() { if [ -n "$g" ] && [ "$g" -gt 1 ] && [ "$c" = "$g" ]; then kill -s "$1" -- "-$g" 2>/dev/null && return 0; fi; ' +
  'kill -s "$1" "$p" 2>/dev/null; }; ' +
  't=0; k=0; r=0; ' +
  'for f in $2; do [ -f "$f" ] || continue; if o "$f"; then s TERM; t=$((t+1)); else rm -f -- "$f"; r=$((r+1)); fi; done; ' +
  'i=0; while [ "$t" -gt 0 ] && [ "$i" -lt "$3" ]; do a=0; ' +
  'for f in $2; do if [ -f "$f" ] && o "$f"; then a=1; fi; done; [ "$a" = 1 ] || break; ' +
  'if sleep 0.2 2>/dev/null; then i=$((i+2)); else sleep 1; i=$((i+10)); fi; done; ' +
  'for f in $2; do [ -f "$f" ] || continue; if o "$f"; then s KILL; k=$((k+1)); fi; rm -f -- "$f"; done; ' +
  'echo "$t $k $r"';

/**
 * F2. $1 = run dir, $2… = basename globs. Removes each matching pidfile whose pid is a number and dead (a pidfile
 * still being written — empty — is left alone). Prints the count removed.
 */
export const RUN_REAP_PROGRAM =
  RUN_DIR_PRELUDE +
  'shift; cd -- "$d" 2>/dev/null || { echo 0; exit 0; }; n=0; ' +
  'for g in "$@"; do for f in $g; do [ -f "$f" ] || continue; p=; read p x 2>/dev/null < "$f"; ' +
  'case "$p" in ""|*[!0-9]*) continue ;; esac; ' +
  'if [ "$p" -gt 1 ] && kill -0 "$p" 2>/dev/null; then continue; fi; ' +
  'rm -f -- "$f" && n=$((n+1)); done; done; echo "$n"';

/**
 * F3 scan. $1 = run dir, $2 = age in minutes. For every plain file older than $2: a `.token` is PRINTED (one name
 * per line — the caller decides), a `.pid` whose pid is alive is kept, anything else is removed. The last line is
 * `#<removed count>`.
 */
export const RUN_DIR_GC_PROGRAM =
  RUN_DIR_PRELUDE +
  'cd -- "$d" 2>/dev/null || { echo "#0"; exit 0; }; n=0; ' +
  'for f in * .[!.]* ..?*; do [ -f "$f" ] || continue; ' +
  '[ -n "$(find "./$f" -prune -mmin +"$2" 2>/dev/null)" ] || continue; ' +
  'case "$f" in *.token) printf "%s\\n" "$f"; continue ;; ' +
  '*.pid) p=; read p x 2>/dev/null < "$f"; if [ "$p" -gt 1 ] 2>/dev/null && kill -0 "$p" 2>/dev/null; then continue; fi ;; esac; ' +
  'rm -f -- "$f" && n=$((n+1)); done; echo "#$n"';

/** F3 tokens. $1 = run dir, $2… = `.token` basenames (anything else is skipped). Prints the count removed. */
export const TOKEN_REMOVE_PROGRAM =
  RUN_DIR_PRELUDE +
  'shift; cd -- "$d" 2>/dev/null || { echo 0; exit 0; }; n=0; ' +
  'for f in "$@"; do case "$f" in ""|*/*|.*) continue ;; *.token) ;; *) continue ;; esac; ' +
  '[ -f "$f" ] || continue; rm -f -- "$f" && n=$((n+1)); done; echo "$n"';

const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_NAME_RE = /^([A-Za-z0-9._:-]{1,128})\.token$/;

function runDirOf(remoteRoot: string): string {
  return `${remoteRoot.replace(/\/+$/, '')}/run`;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** Never let a hung exec hold the caller past `ms` (the exec's own timeout should fire first). */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
    timer.unref?.();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------------------------------------------
// F1 — fence before a cold re-dispatch
// ---------------------------------------------------------------------------------------------------------------

export interface FenceOutcome {
  /** Live processes of the spawnKey that got TERM. */
  termed: number;
  /** Of those, still alive after the wait and KILLed. */
  killed: number;
  /** Pidfiles removed without signalling (dead, malformed, or a reused pid in another group). */
  stale: number;
}

export function fenceArgv(remoteRoot: string, spawnKey: string, waitDeciseconds = FENCE_TERM_WAIT_DECISECONDS): string[] {
  return ['/bin/sh', '-c', FENCE_PROGRAM, 'sh', runDirOf(remoteRoot), pidFileBasenameGlob(spawnKey), String(waitDeciseconds)];
}

export function parseFenceOutput(stdout: string): FenceOutcome | null {
  const m = /^(\d+) (\d+) (\d+)$/m.exec(stdout.trim());
  if (!m) return null;
  return { termed: Number(m[1]), killed: Number(m[2]), stale: Number(m[3]) };
}

export interface FenceOptions {
  hostId: string;
  logger?: LoggerLike;
  timeoutMs?: number;
}

/**
 * F1: kill whatever still runs under `spawnKey` on the machine (an orphan of a dropped connection, a crashed app, a
 * process still dying), then clear its pidfiles. `spawnKey` must already be filename-safe (remoteSpawnKey). Never
 * rejects; resolves null when the fence could not run (the spawn proceeds — the new process has its own pidfile).
 */
export async function fenceSpawnKey(
  exec: MachineExec,
  remoteRoot: string,
  spawnKey: string,
  opts: FenceOptions,
): Promise<FenceOutcome | null> {
  const timeoutMs = opts.timeoutMs ?? FENCE_TIMEOUT_MS;
  try {
    if (!remoteRoot.startsWith('/')) return null;
    const argv = fenceArgv(remoteRoot, spawnKey);
    const r = await withDeadline(exec.exec(argv, { timeoutMs }), timeoutMs + 500, null);
    if (r === null || r.code !== 0) {
      opts.logger?.warn('[hosts] could not fence earlier processes on the environment; spawning anyway', {
        hostId: opts.hostId,
        code: r?.code ?? null,
        timedOut: r === null || r.timedOut,
      });
      return null;
    }
    const outcome = parseFenceOutput(r.stdout);
    if (outcome && outcome.termed > 0) {
      opts.logger?.info('[hosts] fenced earlier processes of this spawn on the environment', { hostId: opts.hostId, ...outcome });
    }
    return outcome;
  } catch (err) {
    opts.logger?.warn('[hosts] fence failed; spawning anyway', { hostId: opts.hostId, error: errorName(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// F2 — run teardown
// ---------------------------------------------------------------------------------------------------------------

/**
 * Basename globs of every pidfile a run's spawns can own: the bare key (`<runId>.<nonce>.pid`) and the lane keys
 * remoteSpawnKey derives from `<runId>:<item>` (`<runId>_<item>-<digest>.<nonce>.pid`). Over-matching is harmless:
 * only DEAD pidfiles are ever removed.
 */
export function runPidFileGlobs(runId: string): string[] {
  if (!RUN_ID_RE.test(runId) || runId === '.' || runId === '..') throw new Error('invalid run id');
  const prefix = runId.replace(/[^A-Za-z0-9._-]/g, '_');
  return [`${prefix}.*.pid`, `${prefix}-*.pid`, `${prefix}_*.pid`];
}

export function runReapArgv(remoteRoot: string, runId: string): string[] {
  return ['/bin/sh', '-c', RUN_REAP_PROGRAM, 'sh', runDirOf(remoteRoot), ...runPidFileGlobs(runId)];
}

/** F2: remove the run's dead pidfiles. Never rejects; resolves the count removed (null = could not run). */
export async function reapRunPidFiles(
  exec: MachineExec,
  remoteRoot: string,
  runId: string,
  opts: { hostId: string; logger?: LoggerLike; timeoutMs?: number },
): Promise<number | null> {
  try {
    if (!remoteRoot.startsWith('/')) return null;
    const r = await exec.exec(runReapArgv(remoteRoot, runId), { timeoutMs: opts.timeoutMs ?? RUN_DIR_OP_TIMEOUT_MS });
    if (r.code !== 0) {
      opts.logger?.warn('[hosts] could not clear finished run files on the environment', { hostId: opts.hostId, code: r.code });
      return null;
    }
    const n = Number(r.stdout.trim().split(/\s+/).pop());
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    opts.logger?.warn('[hosts] could not clear finished run files on the environment', { hostId: opts.hostId, error: errorName(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// F3 — run dir GC
// ---------------------------------------------------------------------------------------------------------------

export function runDirGcArgv(remoteRoot: string, maxAgeMinutes = RUN_DIR_GC_MAX_AGE_MINUTES): string[] {
  return ['/bin/sh', '-c', RUN_DIR_GC_PROGRAM, 'sh', runDirOf(remoteRoot), String(Math.max(1, Math.floor(maxAgeMinutes)))];
}

export function tokenRemoveArgv(remoteRoot: string, tokenNames: readonly string[]): string[] {
  return ['/bin/sh', '-c', TOKEN_REMOVE_PROGRAM, 'sh', runDirOf(remoteRoot), ...tokenNames];
}

/** The scan's output: the stale token files' run ids (only names this app could have written) and the removed count. */
export function parseRunDirGcOutput(stdout: string): { staleTokenRunIds: string[]; removed: number } {
  const staleTokenRunIds: string[] = [];
  let removed = 0;
  for (const line of stdout.split('\n')) {
    const m = TOKEN_NAME_RE.exec(line);
    if (m && m[1] !== '.' && m[1] !== '..') {
      staleTokenRunIds.push(m[1]);
      continue;
    }
    const c = /^#(\d+)$/.exec(line);
    if (c) removed = Number(c[1]);
  }
  return { staleTokenRunIds, removed };
}

export interface RunDirGcOptions {
  hostId: string;
  logger?: LoggerLike;
  maxAgeMinutes?: number;
  timeoutMs?: number;
  /** Whether a stale token's run may lose it (= the run is not active). Absent ⇒ no token is ever removed. */
  canRemoveToken?: (runId: string) => boolean;
  /** Called with the run ids about to lose their token, BEFORE the remove (cache invalidation). */
  beforeRemoveTokens?: (runIds: readonly string[]) => void;
}

export interface RunDirGcOutcome {
  /** Pidfiles of dead processes and other stale files. */
  removed: number;
  /** Token files removed. */
  tokensRemoved: number;
  /** Stale tokens kept (their run is active, or no predicate). */
  tokensKept: number;
}

/** F3: collect `<remoteRoot>/run`. Never rejects; null when the scan could not run. */
export async function gcRemoteRunDir(exec: MachineExec, remoteRoot: string, opts: RunDirGcOptions): Promise<RunDirGcOutcome | null> {
  const timeoutMs = opts.timeoutMs ?? RUN_DIR_OP_TIMEOUT_MS;
  try {
    if (!remoteRoot.startsWith('/')) return null;
    const scan = await exec.exec(runDirGcArgv(remoteRoot, opts.maxAgeMinutes), { timeoutMs });
    if (scan.code !== 0) {
      opts.logger?.warn('[hosts] run folder cleanup could not run on the environment', { hostId: opts.hostId, code: scan.code });
      return null;
    }
    const { staleTokenRunIds, removed } = parseRunDirGcOutput(scan.stdout);
    const removable = opts.canRemoveToken ? staleTokenRunIds.filter((id) => opts.canRemoveToken?.(id) === true) : [];
    let tokensRemoved = 0;
    if (removable.length > 0) {
      opts.beforeRemoveTokens?.(removable);
      const r = await exec.exec(tokenRemoveArgv(remoteRoot, removable.map((id) => `${id}.token`)), { timeoutMs });
      if (r.code === 0) {
        const n = Number(r.stdout.trim());
        tokensRemoved = Number.isFinite(n) ? n : 0;
      } else {
        opts.logger?.warn('[hosts] stale run tokens could not be removed on the environment', { hostId: opts.hostId, code: r.code });
      }
    }
    const outcome = { removed, tokensRemoved, tokensKept: staleTokenRunIds.length - removable.length };
    if (outcome.removed > 0 || outcome.tokensRemoved > 0) {
      opts.logger?.info('[hosts] cleaned up stale run files on the environment', { hostId: opts.hostId, ...outcome });
    }
    return outcome;
  } catch (err) {
    opts.logger?.warn('[hosts] run folder cleanup failed on the environment', { hostId: opts.hostId, error: errorName(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// F2 — live remote processes + the quit drain
// ---------------------------------------------------------------------------------------------------------------

/** One live SshHost spawn, as the tracker sees it. */
export interface TrackedRemoteProcess {
  hostId: string;
  proc: Pick<HostProcess, 'stdin' | 'once'>;
  /** Signal the remote process group from the spawn's pidfile (KILL_PROGRAM over ssh). Must not reject. */
  signalRemote(signal: 'TERM' | 'KILL', timeoutMs: number): Promise<void>;
  /** SIGKILL the local ssh child. Must not throw. */
  killLocal(): void;
}

export interface DrainOutcome {
  total: number;
  /** Exited within the budget. */
  exited: number;
  /** Still alive after the TERM window: KILLed (remote group + local ssh). */
  forced: number;
}

export interface DrainOptions {
  budgetMs?: number;
  /** Test seam: resolves after `ms`. Default an unref'd setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  logger?: LoggerLike;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Every live remote process SshHost spawned in this app (registered at spawn, removed at exit/close), so the quit
 * drain can reach the ones the managers have not torn down yet.
 */
export class RemoteProcessTracker {
  private readonly live = new Set<TrackedRemoteProcess>();

  /** Returns the idempotent untrack function (call it on exit / close). */
  add(entry: TrackedRemoteProcess): () => void {
    this.live.add(entry);
    return () => {
      this.live.delete(entry);
    };
  }

  get size(): number {
    return this.live.size;
  }

  list(): TrackedRemoteProcess[] {
    return [...this.live];
  }

  /**
   * Quit drain: stdin EOF + remote TERM to every live process at once; whatever is still tracked at ~60 % of the
   * budget gets remote KILL + local SIGKILL. Resolves when all have exited or the budget (default 2 s) is spent —
   * never later. Never rejects.
   */
  async drain(opts: DrainOptions = {}): Promise<DrainOutcome> {
    const entries = this.list();
    if (entries.length === 0) return { total: 0, exited: 0, forced: 0 };
    const budget = Math.max(0, opts.budgetMs ?? QUIT_DRAIN_BUDGET_MS);
    const sleep = opts.sleep ?? realSleep;
    const termWindow = Math.floor(budget * 0.6);
    const killWindow = budget - termWindow;
    const allGone = new Promise<void>((resolve) => {
      const check = (): void => {
        if (entries.every((e) => !this.live.has(e))) resolve();
      };
      for (const e of entries) {
        try {
          e.proc.once('exit', () => queueMicrotask(check));
          e.proc.once('close', () => queueMicrotask(check));
        } catch {
          /* a broken fake: the budget still bounds the drain */
        }
      }
      check();
    });

    for (const e of entries) {
      try {
        e.proc.stdin.end();
      } catch {
        /* already closed */
      }
      void e.signalRemote('TERM', Math.max(250, termWindow)).catch(() => undefined);
    }
    await Promise.race([allGone, sleep(termWindow)]);

    const survivors = entries.filter((e) => this.live.has(e));
    for (const e of survivors) {
      void e.signalRemote('KILL', Math.max(250, killWindow)).catch(() => undefined);
      try {
        e.killLocal();
      } catch {
        /* already gone */
      }
    }
    if (survivors.length > 0) await Promise.race([allGone, sleep(killWindow)]);
    const outcome = { total: entries.length, exited: entries.filter((e) => !this.live.has(e)).length, forced: survivors.length };
    opts.logger?.info('[hosts] remote processes drained on quit', { ...outcome });
    return outcome;
  }
}

/** The app-wide tracker every SshHost registers with by default (HostsService.shutdown drains it). */
export const remoteProcessTracker = new RemoteProcessTracker();
