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
 * Connection reuse: ControlMaster=auto with sockets under `<cyboflow dir>/ssh`. The directory is re-ensured
 * (exists, is a directory, mode 0700) on EVERY call with one cheap stat — a dir removed while the app runs makes
 * ssh's mux bind fail with ENOENT, which is fatal (exit 255) rather than a fallback, so it is never cached. The
 * socket path must fit macOS's 104-byte sun_path INCLUDING the 17-byte temporary suffix ssh appends while it
 * binds, so the expanded path is kept well under 100 bytes; a data dir too long for that (or one that cannot be
 * created) falls back to ControlMaster=no with a warning instead of failing the connection.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

export interface ProcessRunOptions {
  stdin?: string;
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

/** Structural view of the transport used by SshHost / the preflight engine (tests inject fakes). */
export interface SshTransportLike {
  exec(target: string, remoteArgv: readonly string[], opts?: SshExecOptions): Promise<ExecResult>;
  runScript(target: string, script: string, opts?: SshExecOptions): Promise<ExecResult>;
  closeMaster(target: string): void;
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
  logger?: LoggerLike;
}

/** POSIX single-quote one word for a remote shell: `'` -> `'\''`. */
export function shQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The remote command string ssh sends: every word single-quoted, joined by spaces. */
export function quoteRemoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('remote argv is empty');
  for (const word of argv) {
    if (word.includes('\0')) throw new Error('remote argv contains a NUL byte');
  }
  return argv.map(shQuote).join(' ');
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
      child = spawn(file, [...args], { env: opts.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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

export class SshTransport implements SshTransportLike {
  private readonly runner: ProcessRunner;
  private readonly controlDir: () => string;
  private readonly ensureDir: (dir: string) => void;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly logger: LoggerLike | undefined;
  private warnedLongPath = false;
  private warnedDir = false;

  constructor(deps: SshTransportDeps = {}) {
    this.runner = deps.runner ?? spawnCapture;
    this.controlDir = deps.controlDir ?? (() => path.join(getCyboflowDirectory(), 'ssh'));
    this.ensureDir = deps.ensureDir ?? ensureControlDir;
    this.env = deps.env ?? (() => buildCommandEnv());
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
    const base = [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
    ];
    const cp = this.controlPath();
    if (cp === null) return [...base, '-o', 'ControlMaster=no'];
    return [...base, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${cp}`];
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
