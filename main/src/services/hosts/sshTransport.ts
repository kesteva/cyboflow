/**
 * SshTransport — every ssh invocation the Environments core makes (preflight probe, MachineExec / MachineFs /
 * GitExecutor of an SshHost, ControlMaster teardown). The interactive terminal (`ssh -tt`) is NOT here: it is
 * a PTY spawn owned by hostTerminalManager.ts.
 *
 * Rules (spec "Secrets" + "ssh"):
 *  - ssh is always spawned with an argv ARRAY (never a shell string), `--` before the destination, and the
 *    destination validated against SSH_TARGET_RE first.
 *  - ssh concatenates the words after the destination and the REMOTE shell parses the result, so a remote
 *    argv is POSIX single-quoted word by word (`'` -> `'\''`). `runScript` sidesteps quoting entirely by
 *    sending the script on stdin to `/bin/sh -s`.
 *  - Nothing secret goes on argv. Remote stderr (and both streams of a script) pass through redactSecrets().
 *  - Never throws for a non-zero exit, a spawn failure or a timeout: the answer is an ExecResult. It throws
 *    only for caller bugs (an invalid destination, an empty argv, a NUL byte in an argument).
 *
 * Long-lived and bulk traffic (M2): `spawnStreaming` (an agent process with piped stdio), `openForward` (the orch
 * socket `-R` forward) and `pushStream` (toolchain upload) never print a banner into the data stream (`-T`, never
 * `-t`; `-o LogLevel=ERROR` keeps ssh's informational chatter — the sshd Banner included — off stderr while real
 * errors still reach it for classification). A forward and a dedicated spawn run on their OWN connection
 * (`ControlMaster=no`, `ControlPath=none`): the shared master's `ControlPersist` idle exit and `closeMaster`'s
 * `ssh -O exit` (run on every registry invalidate) would otherwise tear down a running agent or the orch link.
 *
 * Connection reuse: ControlMaster=auto with sockets under `<cyboflow dir>/ssh`. The directory is re-ensured
 * (exists, is a directory, mode 0700) on EVERY call with one cheap stat — a dir removed while the app runs makes
 * ssh's mux bind fail with ENOENT, which is fatal (exit 255) rather than a fallback, so it is never cached. The
 * socket path must fit macOS's 104-byte sun_path INCLUDING the 17-byte temporary suffix ssh appends while it
 * binds, so the expanded path is kept well under 100 bytes; a data dir too long for that (or one that cannot be
 * created) falls back to ControlMaster=no with a warning instead of failing the connection.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { redactSecrets, SSH_TARGET_RE } from '../../../../shared/types/hosts';
import type { ExecResult } from '../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../orchestrator/types';
import { InvalidSshTargetError } from '../../orchestrator/hosts/errors';
import { getCyboflowDirectory } from '../../utils/cyboflowDirectory';
import { buildCommandEnv } from '../../utils/runGit';

export const SSH_CONNECT_TIMEOUT_S = 8;
export const DEFAULT_SSH_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;
/** sun_path is 104 bytes on macOS (incl. NUL); ssh binds `<ControlPath>.<16 random chars>` first, then renames. */
const SUN_PATH_MAX = 104;
const SSH_BIND_SUFFIX_BYTES = 17;
/** `%C` expands to a 40-hex-char hash of (local host, remote host, port, user). */
const CONTROL_FILE_BYTES = '/cm-'.length + 40;
/** How long openForward waits for the remote socket to appear (spec A2: ≤ 5 s). */
export const FORWARD_READY_TIMEOUT_MS = 5_000;
const FORWARD_POLL_MS = 200;
const FORWARD_STDERR_TAIL_BYTES = 8 * 1024;

export interface ProcessRunOptions {
  stdin?: string;
  /** Working directory of the LOCAL child (LocalHost exec); ssh calls never set it. */
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

/** Runs a binary with an argv array and captures both streams. Never rejects. */
export type ProcessRunner = (file: string, args: readonly string[], opts: ProcessRunOptions) => Promise<ExecResult>;

export interface SshExecOptions {
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Starts a local child (ssh) with an argv array. Default node:child_process.spawn; tests inject fakes. */
export type ProcessSpawner = (file: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;

export interface SpawnStreamingOptions {
  stdin: 'pipe';
  /** Own connection (ControlMaster=no, ControlPath=none) instead of the shared master. */
  dedicated: boolean;
}

export interface ForwardSpec {
  /** Absolute remote socket path (no `~`, no `:`). Its parent is created 0700 first. */
  remoteSock: string;
  /** Absolute local socket path the forwarded connections reach. */
  localSock: string;
}

/**
 * A running `ssh -N -R remoteSock:localSock`. `ready` settles exactly once: it resolves when the remote socket
 * exists, and rejects (ForwardFailedError) when the forward fails, times out, or exits / is closed first.
 * 'exit' fires exactly once per handle, ALWAYS — after a failed `ready` too — with the ssh exit code (null for
 * a signal or a forward that never spawned) and the redacted stderr tail.
 */
export interface ForwardHandle {
  readonly ready: Promise<void>;
  readonly exited: boolean;
  close(): void;
  on(event: 'exit', listener: (code: number | null, stderrTail: string) => void): void;
}

export interface PushStreamOptions {
  timeoutMs: number;
  /** Called after each chunk is accepted by ssh's stdin with the running byte total. */
  onProgress?: (bytesSent: number) => void;
  signal?: AbortSignal;
}

/** Structural view of the transport used by SshHost / the preflight engine (tests inject fakes). */
export interface SshTransportLike {
  exec(target: string, remoteArgv: readonly string[], opts?: SshExecOptions): Promise<ExecResult>;
  runScript(target: string, script: string, opts?: SshExecOptions): Promise<ExecResult>;
  closeMaster(target: string): void;
  /** Connection options of the shared (multiplexed) connection, without `--` / the destination. */
  controlArgs(target: string): string[];
  /**
   * A long-lived `ssh -T … -- target <remoteCommand>` with piped stdio. `remoteCommand` is ONE string the remote
   * shell parses — build it with quoteRemoteArgv (services/hosts/remoteLaunch.ts does).
   */
  spawnStreaming(target: string, remoteCommand: string, opts: SpawnStreamingOptions): ChildProcess;
  openForward(target: string, spec: ForwardSpec): ForwardHandle;
  /**
   * Run `/bin/sh -c <remoteScript>` remotely with `source` piped (binary-safe, with backpressure) into its stdin.
   * Never rejects for a remote / ssh / stream failure: the answer is an ExecResult (both streams redacted).
   */
  pushStream(target: string, remoteScript: string, source: Readable, opts: PushStreamOptions): Promise<ExecResult>;
}

export class ForwardFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForwardFailedError';
  }
}

export interface SshTransportDeps {
  runner?: ProcessRunner;
  /** ControlMaster socket directory. Default `<getCyboflowDirectory()>/ssh`. */
  controlDir?: () => string;
  /**
   * Ensure the socket directory exists as a 0700 directory. Called before EVERY multiplexed ssh call, so it must
   * be cheap when the directory is already right. Throwing disables multiplexing for that call.
   */
  ensureDir?: (dir: string) => void;
  /** Child env. Default buildCommandEnv() (login-shell PATH; SSH_AUTH_SOCK inherited). */
  env?: () => NodeJS.ProcessEnv;
  /** Streaming children (spawnStreaming / openForward / pushStream). Default node:child_process.spawn. */
  spawner?: ProcessSpawner;
  /** openForward readiness budget and poll interval (tests shrink them). */
  forwardReadyTimeoutMs?: number;
  forwardPollMs?: number;
  logger?: LoggerLike;
}

/** POSIX single-quote one word for a remote shell: `'` -> `'\''`. */
export function shQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * One word for a REMOTE login shell: single-quoted, with every `'` as `'\''` and every `!` emitted OUTSIDE the
 * quotes as `\!` (`'ab'\!'cd'`). csh/tcsh history-expand `!` even inside single quotes; `\!` is a literal `!` in
 * sh, bash, zsh, fish and csh/tcsh alike.
 */
function remoteShellWord(word: string): string {
  return `'${word.replace(/'/g, `'\\''`).replace(/!/g, `'\\!'`)}'`;
}

/** The remote command string ssh sends: every word quoted (remoteShellWord), joined by spaces. */
export function quoteRemoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('remote argv is empty');
  for (const word of argv) {
    if (word.includes('\0')) throw new Error('remote argv contains a NUL byte');
  }
  return argv.map(remoteShellWord).join(' ');
}

export function assertValidSshTarget(target: string): void {
  if (!SSH_TARGET_RE.test(target)) throw new InvalidSshTargetError();
}

/**
 * Default ensureDir: one lstat on the happy path; (re)creates a missing directory, restores a widened mode, and
 * throws when the path exists but is not a directory (a symlink included — the sockets must not be redirected).
 */
export function ensureControlDir(dir: string): void {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (st === null) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(dir);
  }
  if (!st.isDirectory()) throw new Error('ssh control path is not a directory');
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/** Default runner: node:child_process.spawn (stdin support; no shell; windowsHide). */
export const spawnCapture: ProcessRunner = (file, args, opts) =>
  new Promise<ExecResult>((resolve) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: 'aborted', timedOut: false });
      return;
    }
    const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(file, [...args], {
        env: opts.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    const kill = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const hard = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
      hard.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    timer.unref?.();
    const onAbort = (): void => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null, extraErr?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const stderr = Buffer.concat(err).toString('utf8');
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: extraErr ? `${stderr}${stderr ? '\n' : ''}${extraErr}` : stderr,
        timedOut,
      });
    };
    child.stdout?.on('data', (b: Buffer) => {
      if (outLen >= max) return;
      out.push(b.subarray(0, max - outLen));
      outLen += b.length;
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (errLen >= max) return;
      err.push(b.subarray(0, max - errLen));
      errLen += b.length;
    });
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(typeof code === 'number' ? code : null));
    child.stdin?.on('error', () => {
      /* EPIPE when the remote side exits before reading stdin */
    });
    child.stdin?.end(opts.stdin ?? '');
  });

/** Words every streaming ssh carries: no PTY (clean binary pipes), no informational chatter on stderr. */
const STREAM_ARGS = ['-T', '-o', 'LogLevel=ERROR'] as const;

/** Liveness + batch options shared by the multiplexed and the dedicated connections. */
function baseConnectionArgs(): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
  ];
}

/** Remote prep for a forward: the socket's parent 0700, and no stale socket that would fake readiness. */
// BSD chmod (macOS) has no `--`; $1 is always absolute (assertForwardSocketPath), so it cannot read as an option.
export const FORWARD_PREP_PROGRAM = 'umask 077; mkdir -p -- "$1" && chmod 700 "$1" && rm -f -- "$2"';

/** A forward endpoint: absolute, and free of the characters ssh's `-R a:b` / option parsing cannot carry. */
export function assertForwardSocketPath(p: string): void {
  // eslint-disable-next-line no-control-regex
  if (!p.startsWith('/') || p.includes(':') || /[\u0000-\u001F]/.test(p)) {
    throw new ForwardFailedError('A forwarded socket path must be absolute and contain no ":" or control characters.');
  }
}

const defaultSpawner: ProcessSpawner = (file, args, opts) => spawn(file, [...args], opts);

/** Head-bounded capture of a child stream (the same 4 MB cap as spawnCapture). */
function boundedCollector(max: number): { push(b: Buffer): void; text(): string } {
  const parts: Buffer[] = [];
  let len = 0;
  return {
    push(b: Buffer): void {
      if (len >= max) return;
      parts.push(b.subarray(0, max - len));
      len += b.length;
    },
    text: (): string => Buffer.concat(parts).toString('utf8'),
  };
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new Error('pushStream source produced a non-binary chunk');
}

/** Resolves on 'drain', or as soon as waiting for one is pointless (stdin closed / errored, child gone). */
function waitForDrain(stdin: Writable, child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      stdin.off('drain', done);
      stdin.off('close', done);
      stdin.off('error', done);
      child.off('exit', done);
      resolve();
    };
    stdin.on('drain', done);
    stdin.on('close', done);
    stdin.on('error', done);
    child.on('exit', done);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

export class SshTransport implements SshTransportLike {
  private readonly runner: ProcessRunner;
  private readonly controlDir: () => string;
  private readonly ensureDir: (dir: string) => void;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly spawner: ProcessSpawner;
  private readonly forwardReadyTimeoutMs: number;
  private readonly forwardPollMs: number;
  private readonly logger: LoggerLike | undefined;
  private warnedLongPath = false;
  private warnedDir = false;

  constructor(deps: SshTransportDeps = {}) {
    this.runner = deps.runner ?? spawnCapture;
    this.controlDir = deps.controlDir ?? (() => path.join(getCyboflowDirectory(), 'ssh'));
    this.ensureDir = deps.ensureDir ?? ensureControlDir;
    this.env = deps.env ?? (() => buildCommandEnv());
    this.spawner = deps.spawner ?? defaultSpawner;
    this.forwardReadyTimeoutMs = deps.forwardReadyTimeoutMs ?? FORWARD_READY_TIMEOUT_MS;
    this.forwardPollMs = deps.forwardPollMs ?? FORWARD_POLL_MS;
    this.logger = deps.logger;
  }

  /** The ControlPath option value, or null when multiplexing must be off for this data dir. */
  private controlPath(): string | null {
    const dir = this.controlDir();
    // eslint-disable-next-line no-control-regex
    if (dir.includes('"') || /[\u0000-\u001F]/.test(dir)) return null;
    const expandedBytes = Buffer.byteLength(dir, 'utf8') + CONTROL_FILE_BYTES;
    if (expandedBytes + SSH_BIND_SUFFIX_BYTES >= SUN_PATH_MAX) {
      if (!this.warnedLongPath) {
        this.warnedLongPath = true;
        this.logger?.warn('[hosts] ssh ControlPath would be too long; connection sharing is off', { bytes: expandedBytes });
      }
      return null;
    }
    // Never cached: the directory can be removed (or its mode widened) while the app runs.
    try {
      this.ensureDir(dir);
      this.warnedDir = false;
    } catch (e) {
      if (!this.warnedDir) {
        this.warnedDir = true;
        this.logger?.warn('[hosts] could not create the ssh control directory; connection sharing is off', {
          error: e instanceof Error ? e.name : 'unknown',
        });
      }
      return null;
    }
    // `%` is ssh's token escape; the path is quoted so a space in the data dir survives option parsing.
    return `"${dir.replace(/%/g, '%%')}/cm-%C"`;
  }

  /** Connection options shared by every non-interactive ssh call. */
  controlArgs(target: string): string[] {
    assertValidSshTarget(target);
    const base = baseConnectionArgs();
    const cp = this.controlPath();
    if (cp === null) return [...base, '-o', 'ControlMaster=no'];
    return [...base, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${cp}`];
  }

  /** Options for a connection of its own: it neither rides nor dies with the shared master. */
  dedicatedArgs(target: string): string[] {
    assertValidSshTarget(target);
    return [...baseConnectionArgs(), '-o', 'ControlMaster=no', '-o', 'ControlPath=none'];
  }

  async exec(target: string, remoteArgv: readonly string[], opts: SshExecOptions = {}): Promise<ExecResult> {
    const command = quoteRemoteArgv(remoteArgv);
    const args = [...this.controlArgs(target), '--', target, command];
    const r = await this.runner('ssh', args, {
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs ?? DEFAULT_SSH_EXEC_TIMEOUT_MS,
      signal: opts.signal,
      env: this.env(),
    });
    // stdout is data (file contents, git output) and is returned as-is; stderr is diagnostics.
    return { ...r, stderr: redactSecrets(r.stderr) };
  }

  async runScript(target: string, script: string, opts: SshExecOptions = {}): Promise<ExecResult> {
    const args = [...this.controlArgs(target), '--', target, '/bin/sh', '-s'];
    const r = await this.runner('ssh', args, {
      stdin: script,
      timeoutMs: opts.timeoutMs ?? DEFAULT_SSH_EXEC_TIMEOUT_MS,
      signal: opts.signal,
      env: this.env(),
    });
    return { ...r, stdout: redactSecrets(r.stdout), stderr: redactSecrets(r.stderr) };
  }

  spawnStreaming(target: string, remoteCommand: string, opts: SpawnStreamingOptions): ChildProcess {
    if (remoteCommand.length === 0) throw new Error('remote command is empty');
    if (remoteCommand.includes('\0')) throw new Error('remote command contains a NUL byte');
    const conn = opts.dedicated ? this.dedicatedArgs(target) : this.controlArgs(target);
    return this.spawner('ssh', [...conn, ...STREAM_ARGS, '--', target, remoteCommand], {
      env: this.env(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  openForward(target: string, spec: ForwardSpec): ForwardHandle {
    assertValidSshTarget(target);
    assertForwardSocketPath(spec.remoteSock);
    assertForwardSocketPath(spec.localSock);
    const emitter = new EventEmitter();
    let exited = false;
    let closed = false;
    let child: ChildProcess | null = null;
    let tail = '';
    // Held in an object: control-flow narrowing would otherwise pin a reassigned `let` to its initial null.
    const gate: { settle: ((err?: Error) => void) | null } = { settle: null };
    const ready = new Promise<void>((resolve, reject) => {
      gate.settle = (err?: Error): void => {
        gate.settle = null;
        if (err) reject(err);
        else resolve();
      };
    });
    // A caller that only listens for 'exit' must not trip an unhandled rejection.
    ready.catch(() => undefined);
    const fail = (why: string): void => gate.settle?.(new ForwardFailedError(why));
    const finishExit = (code: number | null): void => {
      if (exited) return;
      exited = true;
      const redacted = redactSecrets(tail).trim();
      fail(closed ? 'The forward was closed before it was ready.' : `The forward exited${redacted ? `: ${lastLine(redacted)}` : '.'}`);
      emitter.emit('exit', code, redacted);
    };
    const killChild = (): void => {
      try {
        child?.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };

    const run = async (): Promise<void> => {
      const dir = path.posix.dirname(spec.remoteSock);
      const prep = await this.exec(target, ['/bin/sh', '-c', FORWARD_PREP_PROGRAM, 'sh', dir, spec.remoteSock], {
        timeoutMs: this.forwardReadyTimeoutMs,
      });
      if (closed) {
        finishExit(null);
        return;
      }
      if (prep.code !== 0) {
        tail = prep.stderr;
        fail(`Could not prepare the remote socket directory${prep.timedOut ? ' (timed out)' : ''}.`);
        finishExit(prep.code);
        return;
      }
      const c = this.spawner('ssh', [
        ...this.dedicatedArgs(target), ...STREAM_ARGS,
        '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes',
        '-R', `${spec.remoteSock}:${spec.localSock}`,
        '--', target,
      ], { env: this.env(), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      child = c;
      c.stderr?.on('data', (b: Buffer) => {
        tail = (tail + b.toString('utf8')).slice(-FORWARD_STDERR_TAIL_BYTES);
      });
      c.on('error', (e: Error) => {
        tail = `${tail}${tail ? '\n' : ''}${e.message}`;
        finishExit(null);
      });
      c.on('close', (code: number | null) => finishExit(typeof code === 'number' ? code : null));

      const deadline = Date.now() + this.forwardReadyTimeoutMs;
      while (!exited && gate.settle !== null) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          fail(`The forward did not come up within ${Math.round(this.forwardReadyTimeoutMs / 1000)} s.`);
          killChild();
          return;
        }
        const probe = await this.exec(target, ['test', '-S', spec.remoteSock], { timeoutMs: remaining });
        if (exited || gate.settle === null) return;
        if (probe.code === 0) {
          gate.settle();
          return;
        }
        await sleep(Math.min(this.forwardPollMs, Math.max(0, deadline - Date.now())));
      }
    };
    run().catch((e: unknown) => {
      tail = `${tail}${tail ? '\n' : ''}${e instanceof Error ? e.message : String(e)}`;
      if (child === null) finishExit(null);
      else {
        fail('The forward failed.');
        killChild();
      }
    });

    return {
      ready,
      get exited(): boolean {
        return exited;
      },
      close: (): void => {
        if (closed || exited) return;
        closed = true;
        fail('The forward was closed before it was ready.');
        killChild();
      },
      on: (event: 'exit', listener: (code: number | null, stderrTail: string) => void): void => {
        emitter.on(event, listener);
      },
    };
  }

  pushStream(target: string, remoteScript: string, source: Readable, opts: PushStreamOptions): Promise<ExecResult> {
    const args = [...this.dedicatedArgs(target), ...STREAM_ARGS, '--', target, quoteRemoteArgv(['/bin/sh', '-c', remoteScript])];
    return new Promise<ExecResult>((resolve) => {
      if (opts.signal?.aborted) {
        resolve({ code: null, stdout: '', stderr: 'aborted', timedOut: false });
        return;
      }
      let child: ChildProcess;
      try {
        child = this.spawner('ssh', args, { env: this.env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        resolve({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false });
        return;
      }
      const out = boundedCollector(DEFAULT_MAX_OUTPUT_BYTES);
      const err = boundedCollector(DEFAULT_MAX_OUTPUT_BYTES);
      let timedOut = false;
      let settled = false;
      let localError = '';
      const kill = (): void => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        const hard = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, KILL_GRACE_MS);
        hard.unref?.();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs);
      timer.unref?.();
      const onAbort = (): void => kill();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (code: number | null, extraErr?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        const extra = [localError, extraErr ?? ''].filter((x) => x.length > 0).join('\n');
        const stderr = err.text();
        resolve({
          code,
          stdout: redactSecrets(out.text()),
          stderr: redactSecrets(extra ? `${stderr}${stderr ? '\n' : ''}${extra}` : stderr),
          timedOut,
        });
      };
      child.stdout?.on('data', (b: Buffer) => out.push(b));
      child.stderr?.on('data', (b: Buffer) => err.push(b));
      child.on('error', (e: Error) => finish(null, e.message));
      child.on('close', (code: number | null) => finish(typeof code === 'number' ? code : null));
      const stdin = child.stdin;
      if (!stdin) {
        localError = 'ssh stdin is not a pipe';
        kill();
        return;
      }
      stdin.on('error', () => {
        /* EPIPE when the remote side exits before reading everything; the exit code tells the story */
      });
      const pump = async (): Promise<void> => {
        let sent = 0;
        for await (const raw of source as AsyncIterable<unknown>) {
          if (settled || stdin.destroyed || stdin.writableEnded) break;
          const buf = toBuffer(raw);
          const accepted = stdin.write(buf);
          sent += buf.length;
          try {
            opts.onProgress?.(sent);
          } catch {
            /* a progress listener never breaks a push */
          }
          if (!accepted) await waitForDrain(stdin, child);
        }
        if (!stdin.destroyed && !stdin.writableEnded) stdin.end();
      };
      pump().catch((e: unknown) => {
        localError = `The local source failed: ${e instanceof Error ? e.message : String(e)}`;
        kill();
      });
    });
  }

  /** Fire-and-forget `ssh -O exit` for the shared master connection (used on stop). Never throws. */
  closeMaster(target: string): void {
    if (!SSH_TARGET_RE.test(target)) return;
    let args: string[];
    try {
      args = this.controlArgs(target);
    } catch {
      return;
    }
    if (args.includes('ControlMaster=no')) return;
    void this.runner('ssh', ['-O', 'exit', ...args, '--', target], { timeoutMs: 5_000, env: this.env() })
      .catch(() => undefined);
  }
}

export type SshFailureKind = 'auth' | 'host-key' | 'dns' | 'timeout' | 'refused' | 'other';

export interface SshFailure {
  kind: SshFailureKind;
  detail: string;
  fix: string;
}

const MAX_DETAIL_CHARS = 300;

/** The last non-empty stderr line, redacted and bounded: the human-readable part of an ssh failure. */
function lastLine(stderr: string): string {
  const lines = redactSecrets(stderr).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const line = lines[lines.length - 1] ?? '';
  return line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS)}…` : line;
}

/** Map an ssh failure (stderr + whether our timeout fired) to a kind, a detail line and a copyable fix. */
export function classifySshFailure(stderr: string, timedOut: boolean, target = '<target>'): SshFailure {
  const line = lastLine(stderr);
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) {
    return {
      kind: 'host-key',
      detail: line || 'Host key verification failed.',
      fix: `Run \`ssh ${target}\` once in Terminal and confirm the host key`,
    };
  }
  if (/Permission denied \(/i.test(stderr)) {
    return {
      kind: 'auth',
      detail: line || 'Permission denied.',
      fix: `ssh-copy-id ${target}  # and make sure the key is loaded in ssh-agent (ssh-add)`,
    };
  }
  if (/Could not resolve hostname|nodename nor servname|Name or service not known/i.test(stderr)) {
    return { kind: 'dns', detail: line || 'Could not resolve the host name.', fix: 'Check the name, or that Tailscale is connected' };
  }
  if (timedOut || /Operation timed out|Connection timed out|timed out during banner exchange/i.test(stderr)) {
    return {
      kind: 'timeout',
      detail: line || 'The connection timed out.',
      fix: 'The machine may be asleep or offline',
    };
  }
  if (/Connection refused/i.test(stderr)) {
    return {
      kind: 'refused',
      detail: line || 'Connection refused.',
      fix: 'Turn on Remote Login (System Settings → General → Sharing)',
    };
  }
  return {
    kind: 'other',
    detail: line || 'ssh failed without an error message.',
    fix: `Run \`ssh ${target}\` in Terminal to see what is wrong`,
  };
}
